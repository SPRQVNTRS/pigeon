/**
 * Database Commands
 */

import { Command } from 'commander';
import { pool } from '#drizzle/db';
import { printSection, printSuccess, printError, c } from '../lib/output';

export function registerDbCommands(program: Command): void {
  const dbCmd = program
    .command('db')
    .description('Database utilities');

  // Check database connection
  dbCmd
    .command('check')
    .description('Check database connection')
    .action(async () => {
      await checkConnection();
    });

  // Show pool stats
  dbCmd
    .command('pool')
    .description('Show connection pool statistics')
    .action(async () => {
      await showPoolStats();
    });

  // Run raw SQL query (read-only)
  dbCmd
    .command('query <sql>')
    .description('Run a read-only SQL query')
    .option('--format <format>', 'Output format: table, json', 'json')
    .action(async (sql, options) => {
      await runQuery(sql, options);
    });

  // Show table info
  dbCmd
    .command('tables')
    .description('List all tables')
    .action(async () => {
      await listTables();
    });

  // Show table schema
  dbCmd
    .command('describe <table>')
    .description('Describe a table structure')
    .action(async (table) => {
      await describeTable(table);
    });

}

async function checkConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as time, current_database() as database, current_user as user');
    client.release();

    printSection('Database Connection');
    console.log(`Status: ${c.green('Connected')}`);
    console.log(`Database: ${result.rows[0].database}`);
    console.log(`User: ${result.rows[0].user}`);
    console.log(`Server Time: ${result.rows[0].time}`);
    printSuccess('Database connection successful');
  } catch (error) {
    printError('Failed to connect to database', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function showPoolStats(): Promise<void> {
  printSection('Connection Pool Statistics');
  console.log(`Total connections: ${pool.totalCount}`);
  console.log(`Idle connections: ${pool.idleCount}`);
  console.log(`Waiting clients: ${pool.waitingCount}`);
}

async function runQuery(sql: string, options: { format: string }): Promise<void> {
  // Security: only allow SELECT queries
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
    printError('Only SELECT queries are allowed');
    process.exitCode = 1;
    return;
  }

  try {
    const client = await pool.connect();
    const result = await client.query(sql);
    client.release();

    if (options.format === 'json') {
      console.log(JSON.stringify(result.rows, null, 2));
    } else {
      // Simple table output
      if (result.rows.length === 0) {
        console.log(c.dim('No results'));
        return;
      }

      const fields = result.fields.map((f) => f.name);
      console.log(fields.join('\t'));
      console.log('-'.repeat(fields.join('\t').length));
      for (const row of result.rows) {
        console.log(fields.map((f) => String(row[f] ?? '')).join('\t'));
      }
      console.log(c.dim(`\n${result.rows.length} row(s)`));
    }
  } catch (error) {
    printError('Query failed', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function listTables(): Promise<void> {
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT table_name,
             pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    client.release();

    printSection('Database Tables');
    for (const row of result.rows) {
      console.log(`  ${row.table_name} (${row.size})`);
    }
    console.log(c.dim(`\n${result.rows.length} table(s)`));
  } catch (error) {
    printError('Failed to list tables', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function describeTable(table: string): Promise<void> {
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);
    client.release();

    if (result.rows.length === 0) {
      printError(`Table "${table}" not found`);
      process.exitCode = 1;
      return;
    }

    printSection(`Table: ${table}`);
    console.log('Column\t\t\tType\t\t\tNullable\tDefault');
    console.log('-'.repeat(80));
    for (const row of result.rows) {
      const colName = row.column_name.padEnd(20);
      const dataType = row.data_type.padEnd(20);
      const nullable = row.is_nullable === 'YES' ? 'YES' : 'NO';
      const defaultVal = row.column_default ? row.column_default.slice(0, 30) : '-';
      console.log(`${colName}\t${dataType}\t${nullable}\t\t${defaultVal}`);
    }
  } catch (error) {
    printError('Failed to describe table', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

