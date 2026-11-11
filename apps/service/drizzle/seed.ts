import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createId } from '@paralleldrive/cuid2';
import { users, apps, apiKeys, domains } from './schema/index';
import { db, client } from './db';
import 'dotenv/config';

const SEED_PASSWORD = 'password';

const SEED_USERS = [
  {
    email: process.env.SUPERADMIN_EMAIL || 'admin@example.com',
    name: 'Admin',
    role: 'admin' as const,
  },
  {
    email: 'editor@example.com',
    name: 'Editor',
    role: 'editor' as const,
  },
] as const;

async function main() {
  try {
    console.log('Seeding database...');

    // Create admin users
    const passwordHash = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD || SEED_PASSWORD, 10);

    for (const seedUser of SEED_USERS) {
      const [created] = await db
        .insert(users)
        .values({
          email: seedUser.email,
          name: seedUser.name,
          password: passwordHash,
          role: seedUser.role,
        })
        .onConflictDoNothing()
        .returning();

      if (created) {
        console.log(`Created ${seedUser.role}: ${created.email}`);
      }
    }

    // Create demo app
    const appId = createId();
    const [demoApp] = await db
      .insert(apps)
      .values({
        id: appId,
        name: 'Demo App',
      })
      .onConflictDoNothing()
      .returning();

    if (demoApp) {
      console.log(`Created app: ${demoApp.name} (id: ${demoApp.id})`);

      // Create API key for demo app
      const raw = randomBytes(32).toString('hex');
      const plaintext = `ske_${raw}`;
      const prefix = plaintext.slice(0, 8);
      const hashedKey = createHash('sha256').update(plaintext).digest('hex');

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          appId: demoApp.id,
          name: 'Default Key',
          hashedKey,
          prefix,
        })
        .onConflictDoNothing()
        .returning();

      if (apiKey) {
        // Print plaintext key once — this is the only time it will be visible
        console.log('');
        console.log('========================================');
        console.log('  API KEY (save this, shown only once)');
        console.log('========================================');
        console.log(`  ${plaintext}`);
        console.log('========================================');
        console.log('');
      }

      // Create sample domain for demo app
      const [domain] = await db
        .insert(domains)
        .values({
          appId: demoApp.id,
          name: 'mail.example.com',
        })
        .onConflictDoNothing()
        .returning();

      if (domain) {
        console.log(`Created domain: ${domain.name}`);
      }
    }

    console.log('Database seeded successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
