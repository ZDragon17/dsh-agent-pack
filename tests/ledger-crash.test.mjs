/**
 * Crash-resilience tests for the pack task ledger (README BUILD .23).
 * Run: node tests/ledger-crash.test.mjs
 *
 * The real ledgerUpsert/ledgerReadSwept live inside the plugin closure and are
 * not exported; these tests verify the SAME on-disk contract they implement
 * (tmp+rename atomic replace, stale sweep, corrupted-file recovery) by
 * replicating the write path exactly and attacking the file states a killed
 * process can leave behind:
 *   1. leftover tmp file from a killed write must not break reads;
 *   2. truncated/unparseable ledger.json must degrade to empty, not crash;
 *   3. a completed tmp+rename cycle always leaves valid JSON;
 *   4. the stale sweep turns long-running entries into 'interrupted'.
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const LEDGER_KEEP = 200;
const LEDGER_STALE_SEC = 6 * 3600;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pack-ledger-test-'));
const file = path.join(dir, 'ledger.json');

// Same write path as ledgerUpsert (index.js): tmp file, then rename over.
async function atomicWrite(entries) {
	await mkdir(dir, { recursive: true });
	const tmpFile = `${file}.tmp`;
	await writeFile(tmpFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
	fs.renameSync(tmpFile, file);
}

async function readSwept() {
	let entries = [];
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8'));
		if (Array.isArray(parsed?.entries)) entries = parsed.entries;
	} catch { /* no ledger yet — fine */ }
	const now = Date.now();
	for (const e of entries) {
		if (e.status === 'running' && e.startedAt && now - Date.parse(e.startedAt) > LEDGER_STALE_SEC * 1000) {
			e.status = 'interrupted';
			e.finishedAt = new Date().toISOString();
		}
	}
	return entries;
}

after(async () => { await rm(dir, { recursive: true, force: true }); });

test('leftover .tmp from a killed write does not break reads', async () => {
	await atomicWrite([{ id: 't-1', status: 'completed' }]);
	await writeFile(`${file}.tmp`, '{"version":1,"entries":[{"id":"t-x"'); // killed mid-write
	const entries = await readSwept();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, 't-1');
});

test('truncated ledger.json degrades to empty, never crashes', async () => {
	await writeFile(file, '{"version":1,"entries":[{"id":"broken"', 'utf8');
	const entries = await readSwept();
	assert.deepEqual(entries, []);
	// next upsert recovers the file fully
	await atomicWrite([{ id: 't-2', status: 'completed' }]);
	assert.equal((await readSwept()).length, 1);
});

test('tmp+rename is atomic: file is always valid JSON after the cycle', async () => {
	const entries = [];
	for (let i = 0; i < 50; i++) {
		entries.push({ id: `t-${i}`, status: 'completed', startedAt: new Date().toISOString() });
		await atomicWrite(entries.slice(-LEDGER_KEEP));
		const parsed = JSON.parse(await readFile(file, 'utf8')); // would throw if torn
		assert.ok(Array.isArray(parsed.entries));
	}
});

test('stale running entries are swept to interrupted on read', async () => {
	const old = new Date(Date.now() - (LEDGER_STALE_SEC + 60) * 1000).toISOString();
	await atomicWrite([{ id: 't-old', status: 'running', startedAt: old }, { id: 't-new', status: 'running', startedAt: new Date().toISOString() }]);
	const entries = await readSwept();
	assert.equal(entries.find((e) => e.id === 't-old').status, 'interrupted');
	assert.equal(entries.find((e) => e.id === 't-new').status, 'running');
});
