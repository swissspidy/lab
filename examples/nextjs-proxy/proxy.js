// Runs the lab's experiments: buckets visitors, serves the variant to its
// share from the variant's origin, and forwards beacons to the lab.
// LAB_URL is the lab's collector; unset, nothing changes.
import { NextResponse } from 'next/server';
import { createLabProxy } from '@lab/next';

export const proxy = createLabProxy({ NextResponse, lab: process.env.LAB_URL, cacheMs: Number(process.env.LAB_CACHE_MS ?? 5000) });
