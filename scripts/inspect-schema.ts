import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

async function main() {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name
  `;
  console.log("TABLES:", tables.map((t) => t.table_name));

  const columns = await sql<
    { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
  >`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `;

  const constraints = await sql<
    { table_name: string; constraint_name: string; constraint_type: string }[]
  >`
    select tc.table_name, tc.constraint_name, tc.constraint_type
    from information_schema.table_constraints tc
    where tc.table_schema = 'public'
    order by tc.table_name, tc.constraint_type
  `;

  const fks = await sql<
    {
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
      delete_rule: string;
    }[]
  >`
    select
      tc.table_name, kcu.column_name,
      ccu.table_name as foreign_table_name,
      ccu.column_name as foreign_column_name,
      rc.delete_rule
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
    order by tc.table_name
  `;

  const indexes = await sql<{ tablename: string; indexname: string; indexdef: string }[]>`
    select tablename, indexname, indexdef from pg_indexes
    where schemaname = 'public' order by tablename, indexname
  `;

  console.log("\nCOLUMNS:");
  for (const c of columns) {
    console.log(`  ${c.table_name}.${c.column_name} ${c.data_type} nullable=${c.is_nullable}`);
  }

  console.log("\nCONSTRAINTS:");
  for (const c of constraints) {
    console.log(`  ${c.table_name}: ${c.constraint_type} (${c.constraint_name})`);
  }

  console.log("\nFOREIGN KEYS:");
  for (const f of fks) {
    console.log(
      `  ${f.table_name}.${f.column_name} -> ${f.foreign_table_name}.${f.foreign_column_name} ON DELETE ${f.delete_rule}`,
    );
  }

  console.log("\nINDEXES:");
  for (const i of indexes) {
    console.log(`  ${i.tablename}: ${i.indexname} :: ${i.indexdef}`);
  }

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
