/**
 * The platform-neutral domain layer.
 *
 * Nothing here imports a platform API, and nothing here should start to. See
 * `docs/platform-decision.md` — the target platform is an open decision, and this layer
 * staying pure is what keeps it deferrable.
 */
export * from './bar-ref.ts';
export * from './timing.ts';
export * from './pass-index.ts';
export * from './schedule-plan.ts';
export * from './arrangement.ts';
export * from './transport.ts';
export * from './project.ts';
