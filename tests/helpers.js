// Shared setup for the rules tests: start a test environment on the emulator,
// act as a guest / member / sysop, and seed data with rules switched off.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

export async function startEnv() {
  return initializeTestEnvironment({
    projectId: 'demo-garage-terminal',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
}

export const guestOf = (env) => () => env.unauthenticatedContext().firestore();
export const asOf = (env) => (uid, email = `${uid}@example.com`) =>
  env.authenticatedContext(uid, { email, email_verified: true }).firestore();

/** Seed data directly, bypassing rules (like the console or a Cloud Function). */
export async function seed(env, fn) {
  await env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
}

export async function seedMember(env, uid, handle, extra = {}) {
  await seed(env, async (db) => {
    await setDoc(doc(db, 'users', uid), { handle, createdAt: new Date(), status: 'active', postCount: 0, ...extra });
    await setDoc(doc(db, 'handles', handle.toLowerCase()), { uid });
    await setDoc(doc(db, 'private', uid), { email: `${uid}@example.com` });
  });
}
