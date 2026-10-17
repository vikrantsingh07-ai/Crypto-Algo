import bcrypt from 'bcryptjs';

/** `npm run hash-password -- "my long passphrase"` → prints a bcrypt hash for ADMIN_PASSWORD_HASH. */
const pw = process.argv[2];
if (!pw || pw.length < 12) {
  process.stderr.write('Usage: npm run hash-password -- "<passphrase of at least 12 characters>"\n');
  process.exit(1);
}
process.stdout.write((await bcrypt.hash(pw, 12)) + '\n');
