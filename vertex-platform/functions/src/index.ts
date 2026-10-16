import { initializeApp } from 'firebase-admin/app';

initializeApp();

export * from './admin';
export * from './provisioning';
export * from './shards';
export * from './shard-readiness';
export * from './stores';
export * from './billing';
export * from './monitoring';
export * from './versioning';
export * from './runtime';
export * from './domains';
export * from './subscriptions';
export * from './logs.functions';
export * from './alerts.functions';
export * from './data-integrity.functions';
export * from './reconcile.functions';
export * from './purge.functions';
export * from './subdomains.functions';
export * from './sites-audit.functions';
