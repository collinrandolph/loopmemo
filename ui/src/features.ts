/**
 * Features that are built and deliberately switched off.
 *
 * **Every flag here hides a user input and nothing else.** The code behind it stays compiled, typed
 * and checked — its tests and browser instrument still run — so turning a flag back on restores the
 * feature exactly as it was rather than a copy that drifted while nobody could reach it. Removing a
 * control by deleting it would lose that; hiding it with CSS would leave it reachable by keyboard.
 */

/**
 * **Bounce is deferred to v2** (decided 2026-09-16), because its open decisions are v2 decisions:
 * `F15` — a bounced project overdubs ~110 ms late — and backlog #4, whether a bounce should be a
 * backing track rather than layer 1, which would change what a bounce *is*.
 *
 * Off, this hides the one control that starts a bounce: **"Bounce to new project" on project
 * settings** (`settings.ts`, the actions row beside Export, Compress and Delete). Everything behind
 * it is untouched — `askBounce`, `runBounce`, `onBounce` in `app.ts`, `src/domain/bounce.ts`,
 * `tests/bounce.test.ts`, `verify-bounce.ts`. Projects already bounced keep working; they are
 * ordinary projects with a mixdown on layer 1.
 *
 * **To restore in v2**, set this true and read `docs/backlog.md` "Deferred to v2" first — the
 * decisions it lists are why it was switched off.
 */
export const BOUNCE_ENABLED = false;
