/**
 * CampusOS Database Seed Script
 *
 * Seeds the platform schema with initial data:
 * - Test organisation and school
 * - Admin user and IAM person record
 * - Default roles and permission catalogue
 *
 * Full implementation added in Steps 5–6.
 */

async function main() {
  console.log('🌱 CampusOS seed script');
  console.log('   Seed data will be added in Steps 5–6.');
  console.log('   Nothing to seed yet.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  });
