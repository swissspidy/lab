export { createLabProxy } from './proxy.ts';
export type { LabProxyOptions, NextResponseLike, ProxyRequest } from './proxy.ts';
export { labBeaconScript } from './beacon.ts';
export { BEACON_PATH, COOKIE_BUCKET, COOKIE_EXPERIMENT, COOKIE_TWEAKS, COOKIE_VISITOR, MAX_TWEAKS, TWEAK_CSS, TWEAK_OPT_IN, assignBucket, parseState, parseTweaks, route, tweakStylesheets } from './route.ts';
export type { Bucket, LabState, RouteDecision } from './route.ts';
