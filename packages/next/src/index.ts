export { createLabProxy } from './proxy.ts';
export type { LabProxyOptions, NextResponseLike, ProxyRequest } from './proxy.ts';
export { labBeaconScript } from './beacon.ts';
export { BEACON_PATH, COOKIE_BUCKET, COOKIE_EXPERIMENT, COOKIE_VISITOR, assignBucket, decide, parseState } from './decide.ts';
export type { Bucket, Decision, LabState } from './decide.ts';
