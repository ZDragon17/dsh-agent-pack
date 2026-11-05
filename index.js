/**
 * @local/dsh-agent-pack — swarm/wolf-pack orchestration of locally installed agent CLIs.
 *
 * Queen/king = the calling agent (it plans and synthesizes); this plugin is the muscle:
 * parallel dispatch over ctx.subprocess, bounded output collection, verify-fix loop.
 *
 * ZERO bare imports by design: @local bundles are linked into the profile checkout,
 * and Node resolves bare imports from the checkout's real path, which cannot see the
 * profile's node_modules. Everything here uses node: builtins only. Tool
 * definitions speak plain enforced-subset JSON Schema throughout: `parameters`
 * and `output.schema` both use array-form `required`, and misplaced keywords
 * are rejected by the registry.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const name = 'tool-agent-pack';
const inject = ['tools', 'subprocess'];

/** Known agent CLI profiles. `template` is an argv array; `{prompt}` is the task slot,
 * `{model}` inside `modelArgs` is spliced in when a model override is requested. */
const KNOWN_AGENTS = [
	{
		name: 'codex', kind: 'coding', scores: { coding: 0.9, research: 0.7, speed: 0.7, cost: 0.6 },
		template: ['codex', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		name: 'opencode', kind: 'coding', scores: { coding: 0.85, research: 0.8, speed: 0.75, cost: 0.7 },
		template: ['opencode', 'run', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		name: 'claude', kind: 'coding', scores: { coding: 0.9, research: 0.85, speed: 0.7, cost: 0.4 },
		// --allowedTools comes AFTER {prompt} on purpose: it takes a space-separated
		// list, so anything positional placed after it gets eaten as another tool
		// name — with the prompt there, claude reports "no prompt provided".
		// Verified end to end: -p + --output-format json + --json-schema + this flag
		// runs real Bash and returns a schema-valid verdict.
		template: ['claude', '-p', '{prompt}', '--allowedTools', 'Bash'],
		modelArgs: ['--model', '{model}'],
	},
	{
		name: 'gemini', kind: 'research', scores: { coding: 0.75, research: 0.85, speed: 0.7, cost: 0.7 },
		template: ['gemini', '-p', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		name: 'qwen', kind: 'coding', scores: { coding: 0.8, research: 0.7, speed: 0.7, cost: 0.8 },
		template: ['qwen', '-p', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		name: 'aider', kind: 'coding', scores: { coding: 0.8, research: 0.5, speed: 0.6, cost: 0.7 },
		template: ['aider', '--message', '{prompt}', '--yes-always'],
		modelArgs: ['--model', '{model}'],
	},
	{
		name: 'copilot', kind: 'coding', scores: { coding: 0.75, research: 0.6, speed: 0.7, cost: 0.6 },
		template: ['copilot', '-p', '{prompt}'],
		modelArgs: ['--model', '{model}'],
	},
	{
		name: 'goose', kind: 'coding', scores: { coding: 0.75, research: 0.65, speed: 0.6, cost: 0.6 },
		template: ['goose', 'run', '--text', '{prompt}'],
		modelArgs: [],
	},
	{
		name: 'amp', kind: 'coding', scores: { coding: 0.8, research: 0.65, speed: 0.7, cost: 0.5 },
		template: ['amp', 'exec', '{prompt}'],
		modelArgs: [],
	},
	{
		name: 'crush', kind: 'coding', scores: { coding: 0.75, research: 0.65, speed: 0.7, cost: 0.7 },
		template: ['crush', 'run', '{prompt}'],
		modelArgs: [],
	},
	{
		name: 'cursor-agent', kind: 'coding', scores: { coding: 0.85, research: 0.7, speed: 0.7, cost: 0.5 },
		template: ['cursor-agent', '-p', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		name: 'kimi', kind: 'coding', scores: { coding: 0.75, research: 0.7, speed: 0.7, cost: 0.8 },
		template: ['kimi', '-p', '{prompt}'],
		modelArgs: ['-m', '{model}'],
	},
	{
		// @oh-my-pi/pi-coding-agent — read/bash/edit/write tools, bun-installed as
		// ~/.bun/bin/omp.exe. Takes the message as a positional argument and answers
		// on stdout. Verified on this machine: `omp "<task>"` printed OMP-OK; its MCP
		// connection warnings go to stdout BEFORE the answer, which is why verdict
		// parsing is line-anchored rather than "last non-empty line".
		name: 'omp', kind: 'coding', scores: { coding: 0.85, research: 0.7, speed: 0.65, cost: 0.8 },
		template: ['omp', '{prompt}'],
		modelArgs: ['--model', '{model}'],
		note: 'oh-my-pi coding agent (bun global). Answers on stdout; MCP warnings may precede the answer.',
	},
	{
		// DSH itself can answer one task and exit: `dsh headless "<task>"`. Kept as a
		// preset because the argv shape is documented in `dsh --help`, but dispatch is
		// NOT verified here — each call boots a full profile, so it is slow (tens of
		// seconds) and it nests a whole harness inside the current one.
		name: 'dsh', kind: 'coding', scores: { coding: 0.85, research: 0.8, speed: 0.25, cost: 0.7 },
		template: ['dsh', 'headless', '{prompt}'],
		modelArgs: [],
		note: 'boots a nested DSH profile per call (slow, heavy). argv shape from `dsh --help`; dispatch unverified.',
	},
];

/** Executables that are runtimes, packagers or plain tools — never agent CLIs.
 * Discovery scans real directories, so this keeps `node`/`npm`/`python` noise out
 * of the registry instead of pretending everything on PATH is an agent. */
const NON_AGENT_NAMES = new Set([
	'node', 'nodejs', 'npm', 'npx', 'pnpm', 'pn', 'pnpx', 'pnx', 'corepack', 'yarn', 'bun', 'bunx', 'deno',
	'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'invoke', 'inv', 'dotenv', 'watchfiles',
	'git', 'gh', 'ssh', 'scp', 'curl', 'wget', 'rg', 'fd', 'jq', 'sed', 'awk', 'grep', 'tar', 'zip', '7z',
	'mcporter', 'fastmcp', 'mcp-server-linkedin', 'linkedin-mcp-server', 'linkedin-scraper-mcp',
	'patchright', 'browser-cookie', 'yt-dlp', 'bili', 'qrcode-terminal-py', 'markdown-it', 'pygmentize',
	'websockets', 'httpx', 'idna', 'keyring', 'cyclopts', 'email_validator', 'normalizer', 'qr', 'wmitest',
	'ivitools', 'pyspnego-parse', 'npm-check-updates', 'ncu', 'tsc', 'tsx', 'esbuild', 'vite', 'webpack',
	'omp-stats', 'mnemopi', 'orca-agent-hook', 'orca-administrator-restart',
]);

/** Exact names worth probing. NOT a word-stem match: probing means EXECUTING
 * `<bin> --version`, and BUILD .21's first cut matched /agent|code|assistant/ —
 * which ran VS Code, pyside6-assistant and Git's start-ssh-agent (that one
 * really deleted ssh-agent sockets as a side effect). Only names known to be
 * agent CLIs get executed; anything else is added via config.extraAgents. */
const AGENT_NAME_HINT = /^(?:codex|claude|claude-code|opencode|omp|pi|gemini|qwen|aider|goose|amp|crush|kimi|copilot|cursor-agent|droid|cline|openhands|plandex|grok|codebuff|agent-reach|opencli|agently-cli)$/i;

/** Directories where agent CLIs actually get installed on this platform, beyond
 * whatever happens to be on PATH right now (a bun/pip/npm global bin is often
 * missing from PATH even though the CLI is installed). */
function discoveryRoots() {
	const home = os.homedir();
	const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
	const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
	const roots = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	// Discover every installed CPython, not a hard-coded version: pip-installed
	// agent CLIs land in <PythonRoot>/Python<VER>/Scripts and the version varies.
	const pythonScripts = [path.join(appData, 'Python'), path.join(localAppData, 'Programs', 'Python')]
		.flatMap((root) => {
			try {
				return fs.readdirSync(root).filter((d) => /^Python\d+$/.test(d)).map((d) => path.join(root, d, 'Scripts'));
			} catch { return []; }
		});
	roots.push(
		path.join(appData, 'npm'),
		path.join(home, '.bun', 'bin'),
		...pythonScripts,
		path.join(home, '.local', 'bin'),
		path.join(home, 'scoop', 'shims'),
		path.join(localAppData, 'Microsoft', 'WindowsApps'),
		path.join(home, '.cargo', 'bin'),
		path.join(home, '.deno', 'bin'),
		'C:\\ProgramData\\chocolatey\\bin',
	);
	return [...new Set(roots)];
}

/** Executable extensions, best first: a directory usually holds foo.exe, foo.cmd
 * and foo.ps1 for the same tool, and they must collapse to one candidate. */
const EXEC_EXT_RANK = ['', '.exe', '.cmd', '.bat', '.ps1'];

function executableRank(fileName) {
	const ext = path.extname(fileName).toLowerCase();
	const rank = EXEC_EXT_RANK.indexOf(ext);
	if (rank >= 0) return rank;
	return ext === '' ? 0 : -1;
}

/** Magpie is not a CLI: it rides DSH-native MCP tools. Registered as a pseudo profile. */
const PSEUDO_AGENTS = [
	{
		name: 'magpie', kind: 'media', health: 'native-mcp',
		versionLine: 'via DSH MCP tools mcp__magpie-image__generate_image / generate_video',
		scores: { coding: 0, research: 0, speed: 0.6, cost: 0.5 },
		template: null, modelArgs: [], manual: true,
		note: '媒体角色（图/视频）由 DSH 原生 worker 用 magpie MCP 承担；本插件不直接派发。',
	},
];

// ---------- schema helpers ----------
// Enforced-subset JSON Schema everywhere. `parameters` used to use the host's
// author dialect (required: true inside each property), but at least one model
// gateway (magpie/zhipu-coding) silently DROPPED tool-call arguments for tools
// whose parameters schema was in that nonstandard shape — standard JSON Schema
// transports fine, so every schema now speaks plain enforced-subset JSON Schema.
function str(description) { return { type: 'string', ...(description ? { description } : {}) }; }
function int(description) { return { type: 'integer', ...(description ? { description } : {}) }; }
function bool(description) { return { type: 'boolean', ...(description ? { description } : {}) }; }

// Enforced-subset object schema (used by output.schema, item schemas, and
// now parameters too).
function objSchema(properties, required = []) {
	return {
		type: 'object',
		additionalProperties: false,
		properties: { ...properties },
		required: [...required],
	};
}

function firstLine(text) {
	const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim().length > 0);
	return (line ?? '').trim().slice(0, 200);
}

function tail(text, maxChars) {
	const s = String(text ?? '');
	return s.length <= maxChars ? s : `…[truncated ${s.length - maxChars} chars]…\n` + s.slice(-maxChars);
}

// Interpreters that re-parse their arguments: a template whose head is one of
// these turns an LLM-authored prompt into a command line. A denylist can never
// be exhaustive — every name here is defence in depth, not the whole boundary.
const SHELL_HEADS = new Set([
	'cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh',
	'wscript', 'cscript', 'mshta', 'node', 'nodejs', 'deno', 'bun', 'python', 'python3',
	'py', 'ruby', 'perl', 'php', 'lua', 'luajit', 'rscript', 'osascript', 'awk', 'gawk',
	'nawk', 'sed', 'wmic', 'ssh', 'scp', 'xargs', 'env', 'nice', 'timeout', 'watch',
	'matlab', 'octave', 'npx', 'npm', 'pnpm', 'yarn', 'make', 'eval', 'exec', 'source',
]);
// Flags that mean "the next argument is code". Only forms that a CLI would not
// use as an ordinary subcommand belong here: `codex exec {prompt}` and
// `opencode run {prompt}` are how those CLIs take a prompt, so bare `exec`/`run`
// must NOT be treated as hand-offs.
const SHELL_HANDOFF_FLAGS = new Set([
	'/c', '/k', '/r', '-c', '-k', '-r', '--eval', '-e', '--exec', '-exec', '-command',
	'--command', '-batch', '-evaluate',
]);
// `--eval=<code>` and `-c=<code>` carry their payload in the same argv element.
const SHELL_INLINE_FLAG = /^(?:--?[a-z]+|\/[a-z]+)=/i;
// Sub-subcommands that take a program on their own command line, used only when
// the head is a known shell/interpreter (deno/bun/node). They are NOT applied to
// ordinary CLIs, because `codex exec {prompt}` and `opencode run {prompt}` are the
// normal way those tools accept a prompt.
const SHELL_SUBCOMMANDS = new Set(['eval', 'exec', 'run', '-e', '-p', 'repl']);
// Aliases whose whole point is "run this string". Kept narrow on purpose: every
// entry here vetoes a legitimate CLI subcommand too.
const SHELL_ALIAS_HEADS = new Set(['start', 'call', 'do', 'help']);

function isHandoffPart(part) {
	if (typeof part !== 'string') return false;
	const lowered = part.toLowerCase();
	return SHELL_HANDOFF_FLAGS.has(lowered) || SHELL_INLINE_FLAG.test(lowered);
}

// An interpreter head with a program-taking subcommand hands the prompt to a
// code interpreter just as `-e` does — but only interpreters qualify, since
// `codex exec/opencode run` are how normal CLIs take their prompt.
function isInterpreterSubcommand(headName, part) {
	return SHELL_HEADS.has(headName) && typeof part === 'string' && SHELL_SUBCOMMANDS.has(part.toLowerCase());
}


// Symmetric with verdictFrom below: only a line-anchored occurrence counts.
// The tasksheet instruction uses a "<PASS 或 FAIL>" placeholder, so a verifier
// quoting the instruction back verbatim cannot match this and forge a verdict.
const WOLF_VERDICT_LINE = /^[ \t>*_-]*WOLF_VERDICT\s*[:：]\s*(PASS|FAIL)\b/gim;

function verdictOf(output) {
	const matches = [...String(output ?? '').matchAll(WOLF_VERDICT_LINE)];
	if (matches.length === 0) return 'missing';
	return matches[matches.length - 1][1].toUpperCase();
}

// Symmetric with verdictOf: no parsable verdict is "missing", never a soft
// "UNCERTAIN" — otherwise a crashed reviewer is silently counted as an opinion.
// Only a line-anchored occurrence counts, so a reviewer quoting the task
// instructions back verbatim cannot manufacture a verdict.
const REVIEW_VERDICT_LINE = /^[ \t>*_-]*REVIEW_VERDICT\s*[:：]\s*(AGREE|REJECT|UNCERTAIN)\b/gim;

function verdictFrom(output) {
	const matches = [...String(output ?? '').matchAll(REVIEW_VERDICT_LINE)];
	if (matches.length === 0) return 'missing';
	return matches[matches.length - 1][1].toUpperCase();
}

// ---------- structured output adapters ----------
// Every healthy CLI on this machine can emit machine-readable output, and using
// it beats parsing prose: the verdict becomes a FIELD (which the CLI can be made
// to enforce with a JSON schema) instead of a line a model might forget, and the
// token/cost spend becomes observable. Each adapter knows three things: the argv
// flags that switch the CLI into JSON mode, the optional flag that pins the final
// answer to a schema, and how to pull (text, structured, usage) back out.
// A parse failure is never fatal: the raw stdout is kept and the text-protocol
// verdict regex still runs, so an unexpected envelope degrades instead of losing
// the worker's answer.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseJsonLines(text) {
	const out = [];
	for (const line of String(text ?? '').split(/\r?\n/)) {
		const s = line.trim();
		if (!s.startsWith('{') && !s.startsWith('[')) continue;
		try { out.push(JSON.parse(s)); } catch { /* a banner or a truncated last line */ }
	}
	return out;
}

function tryJsonObject(text) {
	const s = String(text ?? '').trim();
	if (!s.startsWith('{')) return null;
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
	} catch { return null; }
}

const OUTPUT_ADAPTERS = {
	// claude --output-format json → ONE envelope object:
	//   { type:'result', subtype:'success', is_error:false, result:'<final text>',
	//     structured_output:{...}, usage:{input_tokens,output_tokens,cache_*},
	//     total_cost_usd, permission_denials:[...], session_id }
	// --json-schema takes the schema INLINE as one argv element (verified), so no
	// temp file and no shell quoting is involved.
	claude: {
		jsonArgs: ['--output-format', 'json'],
		schemaArgs: (schemaJson) => ['--json-schema', schemaJson],
		parse(stdout) {
			const env = tryJsonObject(stdout);
			if (!env || env.type !== 'result') return null;
			const text = typeof env.result === 'string' ? env.result : '';
			const u = env.usage ?? {};
			return {
				text,
				structured: env.structured_output ?? tryJsonObject(text),
				usage: {
					input: num(u.input_tokens), output: num(u.output_tokens),
					cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
					costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0,
				},
				sessionId: typeof env.session_id === 'string' ? env.session_id : null,
				denials: Array.isArray(env.permission_denials) ? env.permission_denials.length : 0,
				failed: env.is_error === true,
			};
		},
	},
	// opencode run --format json → JSONL events; assistant text arrives as
	//   {type:'text', part:{type:'text', text:'…'}} and the step that finished
	//   carries {type:'step_finish', part:{tokens:{input,output,cache:{read,write}}, cost}}.
	// No schema flag exists, so its verdict stays on the text protocol.
	opencode: {
		jsonArgs: ['--format', 'json'],
		schemaArgs: null,
		parse(stdout) {
			const events = parseJsonLines(stdout);
			if (events.length === 0) return null;
			const texts = events
				.filter((e) => e?.type === 'text' && e?.part?.type === 'text')
				.map((e) => String(e.part.text ?? ''));
			const finished = events.filter((e) => e?.type === 'step_finish').pop();
			const t = finished?.part?.tokens ?? {};
			const failed = events.some((e) => e?.type === 'error');
			return {
				text: texts.join(''),
				structured: null,
				usage: {
					input: num(t.input), output: num(t.output),
					cacheRead: num(t.cache?.read), cacheWrite: num(t.cache?.write),
					costUsd: typeof finished?.part?.cost === 'number' ? finished.part.cost : 0,
				},
				sessionId: typeof finished?.sessionID === 'string' ? finished.sessionID : null,
				denials: 0,
				failed,
			};
		},
	},
	// codex exec --json → JSONL events: thread.started, item.completed{item},
	// turn.completed / turn.failed. The success shape is parsed defensively
	// (first item whose text field exists), because codex cannot reach its
	// backend from this machine, so only the failure shape could be observed.
	// --output-schema (file-based) is deliberately NOT wired: shipping it untested
	// would be worse than leaving the verdict on the text protocol.
	codex: {
		jsonArgs: ['--json'],
		schemaArgs: null,
		parse(stdout) {
			const events = parseJsonLines(stdout);
			if (events.length === 0) return null;
			const texts = events
				.filter((e) => e?.type === 'item.completed' && e?.item?.type === 'agent_message')
				.map((e) => String(e.item.text ?? ''));
			const done = events.filter((e) => e?.type === 'turn.completed').pop();
			const failedTurn = events.find((e) => e?.type === 'turn.failed');
			const u = done?.usage ?? {};
			return {
				text: texts.join('\n'),
				structured: null,
				usage: {
					input: num(u.input_tokens ?? u.input), output: num(u.output_tokens ?? u.output),
					cacheRead: num(u.cached_input_tokens ?? u.cache_read), cacheWrite: 0, costUsd: 0,
				},
				sessionId: typeof events[0]?.thread_id === 'string' ? events[0].thread_id : null,
				denials: 0,
				failed: !!failedTurn,
			};
		},
	},
};

// Which adapter applies to a registry profile: an explicit `output` field wins
// (so a user can force plain text or name an adapter), otherwise it is inferred
// from the template head — the actual binary name, not the registry key, because
// keys are user-chosen aliases.
function adapterFor(profile) {
	if (!profile) return null;
	if (profile.output === 'text') return null;
	if (profile.output && OUTPUT_ADAPTERS[profile.output]) return OUTPUT_ADAPTERS[profile.output];
	const head = Array.isArray(profile.template) ? String(profile.template[0] ?? '') : '';
	const base = head.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(?:exe|com|cmd|ps1)$/, '');
	return OUTPUT_ADAPTERS[base] ?? null;
}

// A schema-pinned verdict beats a regex: the CLI validates it before printing.
// Kinds stay separate so a wolf verdict can never be read out of a review field.
const VERDICT_SCHEMA_WOLF = JSON.stringify({
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
		reason: { type: 'string' },
	},
	required: ['verdict', 'reason'],
	additionalProperties: false,
});
const VERDICT_SCHEMA_REVIEW = JSON.stringify({
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['AGREE', 'REJECT', 'UNCERTAIN'] },
		reason: { type: 'string' },
	},
	required: ['verdict', 'reason'],
	additionalProperties: false,
});
// Mirror of VERDICT_SCHEMA_NOTE for reviewers; kept beside the schema so the two
// cannot drift apart.
const REVIEW_SCHEMA_NOTE = '结构化作答：本次调用已启用结果 JSON Schema，最终结论必须落在 verdict 字段（只能是 "AGREE"、"REJECT" 或 "UNCERTAIN"，用大写），并在 reason 字段用一句话概括你的主要理由。';

// Structured field first (authoritative), prose regex second (fallback for
// adapters without a schema flag, or an envelope with no structured field).
function verdictOfRun(run, kind = 'wolf') {
	const structured = run?.structured;
	if (structured && typeof structured === 'object') {
		const v = String(structured.verdict ?? '').trim().toUpperCase();
		if (kind === 'wolf' && (v === 'PASS' || v === 'FAIL')) return v;
		if (kind === 'review' && (v === 'AGREE' || v === 'REJECT' || v === 'UNCERTAIN')) return v;
	}
	return kind === 'wolf' ? verdictOf(run?.output) : verdictFrom(run?.output);
}

function sumUsage(runs) {
	const total = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };
	let counted = 0;
	for (const r of runs ?? []) {
		if (!r?.usage) continue;
		counted += 1;
		total.input += num(r.usage.input);
		total.output += num(r.usage.output);
		total.cacheRead += num(r.usage.cacheRead);
		total.costUsd += num(r.usage.costUsd);
	}
	if (counted === 0) return null;
	total.costUsd = Math.round(total.costUsd * 1e4) / 1e4;
	return total;
}

// One line, same wording everywhere, so "did this cost anything?" is answerable
// from the tool result instead of from a vendor dashboard.
function usageLine(u) {
	if (!u) return 'usage: unavailable (no machine-readable output from these agents)';
	const cost = u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(4)}` : '';
	const cache = u.cacheRead > 0 ? ` (cache read ${u.cacheRead})` : '';
	return `usage: ${u.input} in / ${u.output} out${cache}${cost}`;
}

function apply(ctx, config) {
	// Bumped on every behavioural change: the host only re-reads this file when
	// the plugin is (re)applied, so a stale in-memory copy is otherwise invisible.
	// Scan reports it, which makes "which code is actually running?" answerable.
	const BUILD = 'ap-2026-11-05.23';
	const cfg = {
		defaultTimeoutSec: config?.defaultTimeoutSec ?? 600,
		maxOutputChars: config?.maxOutputChars ?? 12000,
		maxWorkers: config?.maxWorkers ?? 6,
		maxPromptChars: config?.maxPromptChars ?? 24000,
	};
	const registryPath = config?.registryPath
		|| path.join(os.homedir(), '.dsh', 'agent-pack', 'registry.json');

	// ---------- registry ----------
	async function readRegistry() {
		try {
			const raw = JSON.parse(await readFile(registryPath, 'utf8'));
			if (raw && typeof raw === 'object' && raw.agents) return raw;
		} catch { /* first run or corrupted file: start over */ }
		return { version: 1, scannedAt: null, agents: {} };
	}

	async function writeRegistry(registry) {
		await mkdir(path.dirname(registryPath), { recursive: true });
		await writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
	}

	async function probeCli(cliName, binPath, timeoutSec = 20) {
		let exe = null;
		let onPath = true;
		try {
			exe = await ctx.subprocess.resolveExecutable(cliName);
		} catch {
			// Found in a discovery root that is not on PATH. Still probe it — a version
			// line is real evidence — but report 'not-on-path': a dispatch template's
			// head must be a bare name that resolveExecutable can find, so this cannot
			// be dispatched until that directory is added to PATH.
			if (!binPath || !isFile(binPath)) return { health: 'absent', versionLine: '' };
			exe = binPath;
			onPath = false;
		}
		const probe = await runProcess({
			argv: [exe, '--version'], timeoutSec, maxChars: 2000,
		});
		const combined = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim();
		const health = (state) => (onPath ? state : 'not-on-path');
		if (probe.spawnError) return { health: health('broken'), versionLine: firstLine(probe.spawnError) };
		if (probe.exitCode === 0 && combined) return { health: health('ok'), versionLine: firstLine(combined) };
		if (probe.exitCode === 0) return { health: health('ok'), versionLine: '(no version output)' };
		return { health: health('broken'), versionLine: firstLine(combined) || `exit ${probe.exitCode}` };
	}

	/** Walk every discovery root and return the executables whose names look like
	 * agent CLIs. This is the difference between "the 12 CLIs I hard-coded" and
	 * "what is actually installed on this machine". */
	function discoverCandidates(maxCount = 24) {
		const found = new Map();
		for (const root of discoveryRoots()) {
			let entries;
			try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
			for (const entry of entries) {
				let isRealFile = entry.isFile();
				if (!isRealFile && entry.isSymbolicLink()) {
					try { isRealFile = fs.statSync(path.join(root, entry.name)).isFile(); } catch { isRealFile = false; }
				}
				if (!isRealFile) continue;
				const rank = executableRank(entry.name);
				if (rank < 0) continue;
				const base = entry.name.slice(0, entry.name.length - path.extname(entry.name).length).toLowerCase();
				if (!base || NON_AGENT_NAMES.has(base) || !AGENT_NAME_HINT.test(base)) continue;
				const prev = found.get(base);
				// One tool installs as foo.exe + foo.cmd + foo.ps1: keep the most directly
				// executable variant so the reported bin path is the real one.
				if (!prev || rank < prev.rank) found.set(base, { name: base, bin: path.join(root, entry.name), rank });
			}
		}
		return [...found.values()].slice(0, maxCount).map(({ name, bin }) => ({ name, bin }));
	}

	async function scanRegistry() {
		const prev = await readRegistry();
		const agents = {};
		const presetNames = new Set();
		for (const known of KNOWN_AGENTS) {
			presetNames.add(known.name);
			const old = prev.agents?.[known.name];
			const manual = old?.manual ? { ...old } : null;
			const profile = manual
				? manual
				: {
					name: known.name, kind: known.kind,
					scores: { ...known.scores },
					template: config?.templates?.[known.name] ?? known.template,
					modelArgs: known.modelArgs ?? [],
					health: 'absent', versionLine: '',
				};
			profile.discoveredBy = manual ? (old.discoveredBy ?? 'manual') : 'preset';
			if (known.note) profile.note = known.note;
			if (!manual) Object.assign(profile, await probeCli(known.name));
			// Measurements come from real runs (pack_eval), not from this scan — a
			// rescan must not erase evidence about how the CLI actually behaved.
			if (old?.measured) profile.measured = old.measured;
			agents[known.name] = profile;
		}
		// Discovery: probes what is installed, not what the preset list guessed.
		// `config.extraAgents` declares CLIs whose argv shape nobody can guess (or
		// whose binary lives off-PATH), so a discovered tool can be promoted to a
		// dispatchable agent by naming its template there.
		const declarations = new Map();
		for (const item of Array.isArray(config?.extraAgents) ? config.extraAgents : []) {
			if (typeof item === 'string' && item.trim()) declarations.set(item.trim().toLowerCase(), { name: item.trim().toLowerCase() });
			else if (item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim()) {
				declarations.set(item.name.trim().toLowerCase(), { ...item, name: item.name.trim().toLowerCase() });
			}
		}
		const discovered = config?.discover === false ? [] : discoverCandidates();
		const candidates = new Map();
		for (const [name, decl] of declarations) candidates.set(name, { name, bin: null, discoveredBy: 'config', decl });
		for (const found of discovered) {
			if (presetNames.has(found.name) || candidates.has(found.name)) continue;
			candidates.set(found.name, { name: found.name, bin: found.bin, discoveredBy: 'scan' });
		}
		for (const [name, candidate] of candidates) {
			const old = prev.agents?.[name];
			if (old?.manual) {
				agents[name] = { ...old, discoveredBy: old.discoveredBy ?? 'manual' };
				continue;
			}
			const declared = candidate.decl ?? {};
			const template = config?.templates?.[name] ?? declared.template ?? old?.template ?? null;
			const profile = {
				name,
				kind: declared.kind ?? old?.kind ?? 'coding',
				// No prior at all for a discovered CLI: its scores stay null, and the
				// routing that reads them falls back to measured evidence only.
				scores: declared.scores ? { ...declared.scores } : (old?.scores ?? null),
				template: Array.isArray(template) ? template : null,
				modelArgs: declared.modelArgs ?? old?.modelArgs ?? [],
				health: 'absent', versionLine: '', discoveredBy: candidate.discoveredBy,
			};
			if (candidate.bin) profile.bin = candidate.bin;
			// Short probes: a hanging tool must not turn one scan into a minute of waits.
			Object.assign(profile, await probeCli(name, candidate.bin, 8));
			if (old?.measured) profile.measured = old.measured;
			agents[name] = profile;
		}
		for (const pseudo of PSEUDO_AGENTS) agents[pseudo.name] = { ...pseudo };
		const registry = { version: 1, scannedAt: new Date().toISOString(), agents };
		await writeRegistry(registry);
		return registry;
	}

	/** Can this profile actually be dispatched right now? */
	function dispatchable(profile) {
		if (!profile) return false;
		if (profile.health !== 'ok') return false;
		return Array.isArray(profile.template) && profile.template.length > 0;
	}

	// ---------- subprocess plumbing ----------
	async function runProcess({ argv, cwd, timeoutSec, maxChars, signal }) {
		// Host contract: spec.cwd is validated unconditionally (validateNoNullByte on
		// undefined throws), so always pass an absolute cwd. Falling back to homedir
		// would hand a workspace-write agent the whole user profile, so the temp dir
		// is the neutral default: writable, disposable, and free of dotfiles.
		const effectiveCwd = cwd || os.tmpdir();
		const handle = ctx.subprocess.spawn({
			argv,
			cwd: effectiveCwd,
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: Math.max(maxChars * 4, 8192) },
				stderr: { maxBytes: Math.max(maxChars * 2, 4096) },
			},
			graceMs: 5000,
			...(signal ? { signal } : {}),
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { handle.terminate(); } catch { /* already gone */ }
		}, timeoutSec * 1000);
		let fallback;
		try {
			const done = await Promise.race([
				handle.done,
				// Last-resort escape hatch: if terminate() itself never lands, give up
				// waiting rather than hang the whole tool call forever.
				new Promise((resolve) => {
					fallback = setTimeout(() => {
						timedOut = true;
						// terminate() already failed once by definition here — try again
						// before abandoning the process, so a leak is the last resort.
						try { handle.terminate(); } catch { /* gone */ }
						resolve({ exitCode: null, signal: 'timeout' });
					}, (timeoutSec + 60) * 1000);
				}),
			]);
			const readCollected = (stream) => {
				const c = handle.collected?.[stream];
				if (!c) return '';
				const v = c.readFrom?.(0);
				if (typeof v === 'string') return v;
				if (v && typeof v === 'object') return String(v.text ?? v.content ?? '');
				return '';
			};
			return {
				exitCode: done.exitCode,
				termSignal: done.signal,
				timedOut,
				stdout: tail(readCollected('stdout'), maxChars),
				stderr: tail(readCollected('stderr'), Math.min(maxChars, 4000)),
			};
		} catch (error) {
			// handle.done rejected (host-level race): the child may still be alive.
			// Kill it instead of leaving it unparented, then surface the error.
			try { handle.terminate(); } catch { /* already gone */ }
			return { spawnError: String(error?.message ?? error), stdout: '', stderr: '' };
		} finally {
			clearTimeout(timer);
			if (fallback) clearTimeout(fallback);
		}
	}

	function buildArgv(profile, task, model, extra = []) {
		const template = Array.isArray(profile.template) && profile.template.length > 0
			? profile.template
			: [profile.name, '{prompt}'];
		// The slot must be found BEFORE substitution: once '{prompt}' is replaced
		// by the task text, indexOf can never find it again, and modelArgs would
		// silently fall back from "insert before the prompt" to "append at the end".
		const slot = template.indexOf('{prompt}');
		let argv = template.map((part) => (part === '{prompt}' ? task : part));
		const modelExtra = model && Array.isArray(profile.modelArgs) && profile.modelArgs.length > 0
			? profile.modelArgs.map((part) => (part === '{model}' ? model : part))
			: [];
		// Output-format flags ride in the same insert as model flags: both are
		// options that must precede the positional prompt.
		const insert = [...modelExtra, ...extra];
		if (insert.length > 0) {
			argv = slot >= 0
				? [...argv.slice(0, slot), ...insert, ...argv.slice(slot)]
				: [...argv, ...insert];
		}
		return argv;
	}

	async function loadProfile(agentName) {
		const registry = await readRegistry();
		const profile = registry.agents?.[agentName];
		if (!profile) {
			throw new Error(`unknown agent "${agentName}" — run pack_registry_scan first (known: ${Object.keys(registry.agents ?? {}).join(', ') || 'none'})`);
		}
		if (profile.health === 'absent') {
			const known = Object.keys(registry.agents ?? {}).join(', ') || 'none';
			throw new Error(`agent "${agentName}" not found on PATH — run pack_registry_scan to discover what is installed (registry: ${known})`);
		}
		if (profile.health === 'not-on-path') {
			throw new Error(`agent "${agentName}" was discovered at ${profile.bin ?? '(unknown path)'} but that directory is not on PATH — `
				+ 'add it to PATH (a template head must be a bare command name), or move the binary into a directory that already is');
		}
		if (profile.health === 'broken') throw new Error(`agent "${agentName}" is unhealthy: ${profile.versionLine}`);
		if (profile.template == null) {
			throw new Error(`agent "${agentName}"${profile.bin ? ` (at ${profile.bin})` : ''} is installed but has no dispatch template — `
				+ 'this plugin will not guess how a CLI wants its prompt. Declare it once in config.templates, e.g. '
				+ `{"${agentName}": ["${agentName}", "{prompt}"]} (or agents.${agentName}.template in registry.json)`);
		}
		// registry.json is an ordinary user-writable file, so a template is an
		// arbitrary-argv primitive. Only accept a bare command name for the
		// executable slot; anything with a path separator or shell metacharacter
		// has to go through resolveExecutable on PATH like a normal CLI.
		const head = Array.isArray(profile.template) ? profile.template[0] : null;
		if (typeof head !== 'string' || head.trim() === '' || /[\s/\\&|<>^%:{}=]/.test(head)) {
			throw new Error(`agent "${agentName}" has an unsafe template head ${JSON.stringify(head)} — `
				+ 'the executable slot must be a bare command name with no path or shell characters');
		}
		// '{prompt}' in the head slot would put the whole task text where the
		// executable name belongs (argv[0]), which resolveExecutable cannot honour.
		if (head.includes('{prompt}')) {
			throw new Error(`agent "${agentName}" template head is {prompt} — the executable slot must name a CLI, not the task text`);
		}
		// Validating head alone is not enough: ['cmd','/c','{prompt}'] passes the
		// head check and then hands the prompt to a shell via the template body,
		// which is exactly the injection path the viaShell guard refuses.
		const headName = head.toLowerCase().replace(/\.(?:exe|com)$/, '');
		if (SHELL_HEADS.has(headName)) {
			throw new Error(`agent "${agentName}" uses the interpreter "${head}" as its template head — `
				+ `that routes prompts through a shell (${[...SHELL_HEADS].join(', ')} are refused). `
				+ 'Point the template at the real CLI binary instead.');
		}
		if (SHELL_ALIAS_HEADS.has(headName)) {
			throw new Error(`agent "${agentName}" uses the shell alias "${head}" as its template head — `
				+ 'that runs its arguments as a command; point the template at the real CLI binary');
		}
		const body = Array.isArray(profile.template) ? profile.template.slice(1) : [];
		const carriesPrompt = body.some((part) => part === '{prompt}');
		// A template with no {prompt} slot would silently drop the task text and
		// dispatch a prompt-less CLI that hangs until timeoutSec — refuse it up front.
		if (!carriesPrompt) {
			throw new Error(`agent "${agentName}" template ${JSON.stringify(profile.template)} has no {prompt} slot — `
				+ 'the task text would be silently dropped. Add "{prompt}" where the prompt belongs, '
				+ `e.g. ["${agentName}", "{prompt}"].`);
		}
		const handoff = body.find((part) => isHandoffPart(part));
		if (handoff && carriesPrompt) {
			throw new Error(`agent "${agentName}" template contains "${handoff}" next to {prompt} — `
				+ 'that is a shell hand-off, and the prompt would be re-parsed as a command');
		}
		// Honest note: gate 1 above already rejects every head in SHELL_HEADS, so
		// this subcommand check is currently unreachable — it exists as cheap
		// defense-in-depth in case the head blacklist is ever loosened. The live
		// gates are the head blacklist, the alias list and the handoff-flag check.
		const subcommand = body.find((part) => isInterpreterSubcommand(headName, part));
		if (subcommand && carriesPrompt) {
			throw new Error(`agent "${agentName}" template runs "${head} ${subcommand} {prompt}" — `
				+ 'an interpreter subcommand would execute the prompt as code');
		}
		return profile;
	}

	function isFile(path) {
		try { return fs.statSync(path).isFile(); } catch { return false; }
	}

	// ---------- measured capability (eval → routing) ----------
	// The scores in KNOWN_AGENTS are a hand-written prior: an opinion about a CLI,
	// written once, never tested. pack_eval produces the only real evidence we
	// have, so routing prefers it when it exists. Measurements are stored as RAW
	// sample records and only turned into numbers when read — a fabricated score
	// never gets written into the registry.
	const DIMENSION_TAGS = { coding: 'coding', research: 'research' };

	function speedScoreOf(medianSec) {
		// 45s maps to 0.5: a run that answers in under a minute is "normal speed",
		// sub-10s saturates near 1, and a multi-minute run decays toward 0.
		if (!(medianSec > 0)) return null;
		return Math.round((1 / (1 + medianSec / 45)) * 100) / 100;
	}

	function dimensionOf(c) {
		for (const tag of c.tags ?? []) {
			const dim = DIMENSION_TAGS[String(tag).toLowerCase()];
			if (dim) return dim;
		}
		return 'general';
	}

	// Raw samples, not rates. A rate cannot be merged (1/1 today + 0/4 tomorrow is
	// not 0.5) and re-running an untagged smoke suite must not erase what a tagged
	// suite proved. Each agent keeps a rolling window of its last N case results;
	// every number shown or routed on is derived from those samples on read.
	const MEASURE_WINDOW = 12;

	function mergeSamples(prev, fresh) {
		const window = [...(Array.isArray(prev?.samples) ? prev.samples : []), ...fresh];
		return window.slice(-MEASURE_WINDOW);
	}

	function summarizeSamples(samples) {
		const list = Array.isArray(samples) ? samples : [];
		const dims = {};
		for (const s of list) {
			const dim = s?.dimension ?? 'general';
			const agg = dims[dim] ?? (dims[dim] = { cases: 0, passed: 0 });
			agg.cases += 1;
			if (s.pass) agg.passed += 1;
		}
		for (const agg of Object.values(dims)) agg.passRate = Math.round((agg.passed / agg.cases) * 100) / 100;
		const durations = list.map((s) => s?.durationMs ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
		const medianSec = durations.length > 0 ? Math.round((durations[Math.floor(durations.length / 2)] / 1000) * 10) / 10 : null;
		const costs = list.map((s) => s?.costUsd ?? 0).filter((c) => c > 0);
		return {
			cases: list.length,
			passed: list.filter((s) => s.pass).length,
			dims,
			medianSec,
			costUsd: costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e4) / 1e4 : 0,
		};
	}

	// One sample per case, grouped per agent.
	function samplesByAgent(results) {
		const out = new Map();
		for (const r of results) {
			if (!r?.agent || r.agent === '*') continue;
			if (!out.has(r.agent)) out.set(r.agent, []);
			// A spawn failure or timeout is a FAILED sample, never a skipped one —
			// averaging only the runs that happened to start would overstate health.
			out.get(r.agent).push({
				at: new Date().toISOString(),
				dimension: dimensionOf(r),
				pass: !!r.pass,
				durationMs: r.durationMs ?? 0,
				costUsd: r.usage?.costUsd ?? 0,
			});
		}
		return out;
	}

	// Which score to route on, and where it came from. Measured data wins; the
	// prior fills the gaps. `source` travels with the plan so the caller can see
	// that a ranking is evidence-based or just an opinion.
	function effectiveScore(profile, dim) {
		const summary = Array.isArray(profile?.measured?.samples) ? summarizeSamples(profile.measured.samples) : null;
		if (summary && summary.cases > 0) {
			if (dim === 'speed') {
				const speed = speedScoreOf(summary.medianSec);
				if (speed != null) return { value: speed, source: `measured(${summary.medianSec}s median)` };
			}
			const hit = summary.dims[dim];
			if (hit && hit.cases > 0) return { value: hit.passRate, source: `measured(${hit.passed}/${hit.cases} ${dim})` };
			// Only an untagged sample speaks to general ability. A research-tagged pass
			// says nothing about coding, so it must not leak into that ranking.
			const general = summary.dims.general;
			if (general && general.cases > 0) return { value: general.passRate, source: `measured(${general.passed}/${general.cases} untagged)` };
		}
		// A discovered CLI has no hand-written prior at all: report that honestly
		// instead of dressing a missing opinion up as a score of 0.
		if (!profile?.scores) return { value: 0, source: 'unscored' };
		return { value: profile.scores[dim] ?? 0, source: 'prior' };
	}

	function measuredLine(profile) {
		const m = profile?.measured;
		if (!m) return null;
		if (!Array.isArray(m.samples)) {
			// Legacy shape written by older builds: show it, but it is not dimension
			// evidence — it was overwritten on every run, including untagged ones.
			return m.cases ? `${m.passed}/${m.cases} passed (legacy record, no samples)` : null;
		}
		const s = summarizeSamples(m.samples);
		if (!s.cases) return null;
		const dims = Object.entries(s.dims).map(([k, v]) => `${k} ${v.passed}/${v.cases}`).join(', ');
		return `${s.passed}/${s.cases} passed`
			+ (dims ? ` (${dims})` : '')
			+ (s.medianSec ? ` · median ${s.medianSec}s` : '')
			+ (s.costUsd ? ` · ~$${s.costUsd}` : '')
			+ (m.at ? ` · last ${String(m.at).slice(0, 19)}` : '');
	}

	// Deterministic frozen-path gate (AI-native SDLC): snapshot size+mtime after
	// the implement phase, compare after every fix round. size+mtime beats mtime
	// alone: edits inside the same second still change the size in the common case.
	function frozenFingerprint(cwd, rel) {
		try {
			const st = fs.statSync(path.resolve(cwd || os.tmpdir(), rel));
			return `${st.size}:${st.mtimeMs}`;
		} catch { return 'missing'; }
	}
	function snapshotFrozen(cwd, rels) {
		return rels.map((rel) => ({ rel, fp: frozenFingerprint(cwd, rel) }));
	}
	function frozenViolations(cwd, snapshot) {
		return snapshot.filter((e) => frozenFingerprint(cwd, e.rel) !== e.fp).map((e) => e.rel);
	}

	// npm installs a .cmd/.ps1 shim on Windows pointing at the real executable.
	// Launching the shim through `cmd /c` re-parses the argument list, which
	// destroys multi-line prompts; find the real target instead.
	//
	// Two shim shapes exist and they need different argv0:
	//   binary CLI  -> "%dp0%\pkg\bin\tool.exe"  %*   → exec the .exe directly
	//   node CLI    -> "%dp0%\node.exe" "%dp0%\pkg\bin.js" %*  → run node with the script
	// Picking the first match blindly yields node.exe, which silently swallows the
	// CLI name and turns "-p" into a module name.
	function realTargetOfShim(shimPath) {
		let text;
		try { text = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
		const dir = path.dirname(shimPath);
		const expand = (raw) => path.resolve(dir, raw
			.replace(/%~dp0%?/gi, dir)
			.replace(/^%dp0%/i, dir)
			.replace(/\\/g, path.sep));
		const candidates = [];
		for (const match of text.matchAll(/"([^"]*\.(?:exe|js|cjs|mjs))"/gi)) {
			const candidate = expand(match[1]);
			if (candidate === shimPath || candidates.includes(candidate)) continue;
			if (isFile(candidate)) candidates.push(candidate);
		}
		const script = candidates.find((c) => /\.(?:js|cjs|mjs)$/i.test(c));
		if (script) {
			const node = candidates.find((c) => /[\\/]node\.exe$/i.test(c)) || process.execPath;
			return { argv: [node, script], viaShell: false };
		}
		const binary = candidates.find((c) => /\.exe$/i.test(c) && !/[\\/]node\.exe$/i.test(c));
		if (binary) return { argv: [binary], viaShell: false };
		return null;
	}

	async function resolveLaunchTarget(command, signal) {
		const executable = await ctx.subprocess.resolveExecutable(command, undefined, signal);
		if (!/\.(cmd|bat|ps1)$/i.test(executable)) return { argv0: executable, prefix: [], viaShell: false };
		const real = realTargetOfShim(executable);
		if (real) return { argv0: real.argv[0], prefix: real.argv.slice(1), viaShell: real.viaShell };
		// Unknown shim shape: the shell is the only way left, and prompts with
		// quotes/newlines will not survive it. Say so instead of failing silently.
		return { argv0: executable, prefix: [], viaShell: true };
	}

	// ---------- 子智能体面板可见性 ----------
	// The 子智能体 panel (and the "N 个子智能体" badge) is the parent session's
	// `subagentCatalog` projection: it is fed exclusively by 'subagent/catalog'
	// events appended to that session (dsh-subagent/types/catalog.ts). An external
	// worker — a child in ANOTHER process, with no local session — is recorded as
	// `mode: 'external'`, which is exactly what these CLI workers are. Appending the
	// same fact the host appends makes every dispatched bee/wolf/verifier/reviewer
	// show up in the panel with its label; it sends no message, wakes nobody, and
	// changes no turn. A failed append is logged and dropped: panel bookkeeping must
	// never be able to fail a dispatch.
	const CATALOG_EVENT = 'subagent/catalog';

	function recordPanelChild(panel) {
		const session = panel?.session;
		if (!session || typeof session.append !== 'function') return null;
		const label = String(panel.label ?? '').trim();
		if (!label) return null;
		try {
			const childId = randomUUID();
			// Shape is validated by the catalog projection's zod schema (.strict():
			// version/childId/childCreatedAt/mode/label and nothing else).
			session.append(CATALOG_EVENT, {
				version: 2,
				childId,
				childCreatedAt: Date.now(),
				mode: 'external',
				label,
			});
			return childId;
		} catch (error) {
			try {
				ctx.logger?.warn?.(`agent-pack: could not record "${label}" in the subagent catalog: ${String(error?.message ?? error)}`);
			} catch { /* logging must never throw into a dispatch */ }
			return null;
		}
	}

	async function runOne(agentName, task, { cwd, timeoutSec, model, signal, panel, schema, schemaNote }) {
		const profile = await loadProfile(agentName);
		// Only after the profile resolves: a typo'd agent name must not leave a
		// phantom entry in the panel claiming a child was started.
		recordPanelChild(panel);
		const started = Date.now();
		// A missing cwd surfaces as a confusing ENOENT naming the executable (Node
		// reports the failed spawn target, not the absent directory). Create the
		// workspace on demand instead of letting that mislead the debugging.
		if (cwd && !fs.existsSync(cwd)) {
			try {
				fs.mkdirSync(cwd, { recursive: true });
			} catch (error) {
				return {
					agent: agentName, ok: false, exitCode: null, timedOut: false,
					spawnError: `cwd ${cwd} does not exist and could not be created: ${String(error?.message ?? error)}`,
					durationMs: Date.now() - started, output: '',
				};
			}
		}
		// The host launches through CreateProcessW-style bindings that do not search
		// PATH for a bare argv[0]: always swap in the resolved absolute executable.
		// JSON-mode flags and a verdict schema (when this CLI honours one) ride in
		// front of the positional prompt.
		const adapter = adapterFor(profile);
		const schemaArgs = schema && adapter?.schemaArgs ? adapter.schemaArgs(schema) : [];
		// When the CLI can enforce a schema, say so in the tasksheet: the model then
		// answers in a validated field instead of relying only on a protocol line we
		// have to regex — and the protocol line still ships, as the fallback for
		// CLIs without schema support.
		const effectiveTask = schemaArgs.length > 0 && schemaNote ? `${task}\n\n${schemaNote}` : task;
		const rawArgv = buildArgv(profile, effectiveTask, model, [...(adapter?.jsonArgs ?? []), ...schemaArgs]);
		let argv;
		try {
			const target = await resolveLaunchTarget(rawArgv[0], signal);
			if (target.viaShell) {
				// cmd.exe re-parses everything after /c, so any prompt carrying shell
				// metacharacters would be executed rather than passed as an argument.
				// Refuse instead of silently handing an LLM-authored prompt to a shell.
				return {
					agent: agentName, ok: false, exitCode: null, timedOut: false,
					spawnError: `refusing to run "${rawArgv[0]}" through cmd.exe: the shim's real target could not be resolved, `
						+ 'and any prompt would be re-parsed by the shell. Register this CLI with an explicit template that '
						+ 'points at an absolute .exe, or install a binary build.',
					durationMs: Date.now() - started, output: '',
				};
			}
			argv = [target.argv0, ...target.prefix, ...rawArgv.slice(1)];
		} catch (error) {
			return {
				agent: agentName, ok: false, exitCode: null, timedOut: false,
				spawnError: `resolveExecutable(${rawArgv[0]}): ${String(error?.message ?? error)}`,
				durationMs: Date.now() - started, output: '',
			};
		}
		const result = await runProcess({
			argv,
			cwd,
			timeoutSec: timeoutSec != null && timeoutSec > 0 ? timeoutSec : cfg.defaultTimeoutSec,
			maxChars: cfg.maxOutputChars,
			signal,
		});
		// Machine-readable envelope first: the same parse yields the answer text,
		// the (schema-validated, when available) verdict field, and the token spend.
		// A parse failure is survivable — the raw streams stay as the fallback.
		const stdout = result.stdout ?? '';
		const stderr = result.stderr ?? '';
		let parsed = null;
		if (adapter && !result.spawnError && stdout.trim()) {
			try { parsed = adapter.parse(stdout); } catch { parsed = null; }
		}
		const parsedText = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
		// With a schema pinned, the CLI's answer TEXT is usually just the JSON of the
		// structured object — technically correct, useless to a human reader. When
		// that is what came back, show the verdict/verdict-reason pair instead.
		const structuredHead = parsed?.structured && typeof parsed.structured.verdict === 'string'
			? `verdict: ${parsed.structured.verdict}`
				+ (typeof parsed.structured.reason === 'string' && parsed.structured.reason.trim()
					? ` — ${parsed.structured.reason.trim().replace(/\s+/g, ' ').slice(0, 500)}`
					: '')
			: null;
		const answerText = structuredHead && /^[[{]/.test(parsedText) ? structuredHead : parsedText;
		// stdout wins, but stderr is never dropped: auth failures, quota errors and
		// stack traces live there, and a healthy banner on stdout often hides them.
		let output;
		if (answerText) {
			output = stderr.trim() && !answerText.includes(stderr.trim())
				? `${answerText}\n--- stderr ---\n${stderr}`
				: answerText;
		} else if (parsed) {
			// Envelope understood but it carried no answer text (empty result, or a
			// turn that failed before answering). Keep a readable trace, not nothing.
			output = '[no answer text in the machine-readable envelope]\n'
				+ tail(`${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`, 2000);
		} else if (stdout.trim() && stderr.trim() && !stdout.includes(stderr.trim())) {
			output = `${stdout}\n--- stderr ---\n${stderr}`;
		} else {
			output = stdout.trim() ? stdout : stderr;
		}
		const parsedMeta = parsed ? {
			structured: parsed.structured ?? null,
			usage: parsed.usage,
			...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
			...(parsed.denials > 0 ? { denials: parsed.denials } : {}),
			...(parsed.failed ? { agentReportedFailure: true } : {}),
		} : {};
		return {
			agent: agentName,
			ok: !result.spawnError && !result.timedOut && result.exitCode === 0,
			exitCode: result.exitCode ?? null,
			timedOut: !!result.timedOut,
			spawnError: result.spawnError ?? null,
			durationMs: Date.now() - started,
			output: tail(output, cfg.maxOutputChars),
			...parsedMeta,
		};
	}

	// Deterministic gate (AI-native SDLC): run a caller-supplied argv ARRAY in the
	// workspace before any LLM verifier spends tokens. argv only — never a shell
	// string — so the injection surface stays at zero; argv[0] goes through the
	// same PATH/shim resolution as agent templates.
	async function runPlainCommand(argv, { cwd, timeoutSec, signal }) {
		const started = Date.now();
		let launch;
		try {
			launch = await resolveLaunchTarget(String(argv[0]), signal);
		} catch (error) {
			return {
				ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - started,
				output: '', spawnError: `resolveExecutable(${argv[0]}): ${String(error?.message ?? error)}`,
			};
		}
		if (launch.viaShell) {
			return {
				ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - started,
				output: '',
				spawnError: `refusing to run "${argv[0]}" through cmd.exe: the shim's real target could not be resolved — point verifyCommand at the real executable`,
			};
		}
		const result = await runProcess({
			argv: [launch.argv0, ...launch.prefix, ...argv.slice(1)],
			cwd,
			timeoutSec,
			maxChars: cfg.maxOutputChars,
			signal,
		});
		const stdout = result.stdout ?? '';
		const stderr = result.stderr ?? '';
		const output = stdout.trim() && stderr.trim() && !stdout.includes(stderr.trim())
			? `${stdout}\n--- stderr ---\n${stderr}`
			: (stdout.trim() ? stdout : stderr);
		return {
			ok: !result.spawnError && !result.timedOut && result.exitCode === 0,
			exitCode: result.exitCode ?? null,
			timedOut: !!result.timedOut,
			durationMs: Date.now() - started,
			output,
			spawnError: result.spawnError ?? null,
		};
	}

	async function runWorker(worker, objective, { cwd, timeoutSec, model, signal, mode, promptChars, context, panelSession }) {
		const label = worker.label ?? worker.role ?? worker.agent;
		// A fix round already composed a budget-aware prompt; re-bounding it at the
		// default size would silently halve it.
		const workerBudget = promptChars ?? CHAR_BUDGET;
		try {
			const role = worker.role ?? 'research';
			const contract = mode === 'wolf'
				? [
					`你在一个狼群（并行实现团队）中担任「${role}」角色，狼王已与你约定分工。`,
					'只做本角色范围内的工作，绝不修改其他角色的文件。',
					'完成后用 3-6 行汇报：改了哪些文件、做了什么、遗留风险。',
				]
				: [
					`你在一个蜂群（并行调研团队）中担任「${role}」调研角度，蜂后将汇总你的报告。`,
					'只做调研与推理，**不要写文件、不要修改任何文件**。',
					'不要派生子任务或子 agent；你的产出就是这份报告本身。',
					'时间纪律：优先基于已有知识直接作答；确需联网检索时，先写下已有结论，再做一次有边界的检索作为补充——禁止先漫游检索再动笔。',
					'报告用 Markdown：先给结论，再给支撑要点，最后给不确定项。控制在 400 行内。',
				];
			// Project context injected into EVERY tasksheet (AI-native SDLC: the
			// convention files — CLAUDE.md/AGENTS.md equivalents — must be read
			// before writing). Missing paths are flagged, never guessed around.
			const contextLines = Array.isArray(context) && context.length > 0
				? [
					'',
					'项目上下文（动笔前先读这些文件；标注「缺失」的说明路径不对，不要臆造其内容）：',
					...context.map((p) => {
						const rel = String(p);
						const exists = fs.existsSync(path.resolve(cwd || os.tmpdir(), rel));
						return `- ${rel}${exists ? '' : '（缺失）'}`;
					}),
				]
				: [];
			const task = [
				`【任务书 · ${mode === 'wolf' ? '狼群' : '蜂群'}】`,
				`总体目标：${boundedText('目标过长，只说与本角色相关的部分', objective, OBJECTIVE_BUDGET)}`,
				`你的角色：${role}（标记：${label}）`,
				`你的任务：${boundedText('任务正文过长，请优先完成能落地的部分', worker.prompt, workerBudget)}`,
				...contextLines,
				'',
				'工作要求：',
				...contract.map((line) => `- ${line}`),
				'',
				`工作目录：${cwd || os.tmpdir()}`,
			].join('\n');
			const run = await runOne(worker.agent, boundedTask(label, task), {
				cwd, timeoutSec, model: worker.model ?? model, signal,
				// Visible in the 子智能体 panel as "蜂群·<role> (agent)" / "狼群·…":
				// the queen/king can then see its own pack without reading tool output.
				panel: { session: panelSession, label: `${mode === 'wolf' ? '狼群' : '蜂群'}·${label} (${worker.agent})` },
			});
			return { label, role: worker.role ?? null, tasksheet: task, ...run };
		} catch (error) {
			return { label, role: worker.role ?? null, agent: worker.agent, ok: false, error: String(error?.message ?? error) };
		}
	}

	// Verifiers and reviewers are dispatched through runOne, which throws on an
	// unknown/unhealthy agent. Isolating each spawn keeps one bad agent name from
	// destroying a whole round of already-collected output.
	async function settleOne(agentName, task, options) {
		try {
			return await runOne(agentName, task, options);
		} catch (error) {
			return {
				agent: agentName, ok: false, exitCode: null, timedOut: false,
				spawnError: String(error?.message ?? error), durationMs: 0, output: '',
			};
		}
	}

	// Failure reason for phase-log lines: a bare "failed" hides whether the wolf
	// timed out (caller should raise timeoutSec) or never spawned (config bug).
	const failWhy = (w) => `failed${w.timedOut ? ` (timed out in ${Math.round((w.durationMs ?? 0) / 1000)}s)` : w.spawnError ? ` (${w.spawnError})` : w.error ? ` (${w.error})` : ''}`;

	// One verify round across all verifiers. Every verifier must agree: a single
	// FAIL (or an unparsable verdict) blocks the pass. Extracted so the round can
	// be reasoned about — and tested — without the fix loop around it.
	const VERDICT_LINE = '结束时必须输出单独一行：WOLF_VERDICT: <PASS 或 FAIL>（把尖括号里的词换成你的结论）';
	// Only appended when the CLI actually accepts a schema flag (claude today).
	// It does not replace VERDICT_LINE: the answer text is still prose for humans,
	// and the schema guarantees the verdict field is machine-checkable.
	const VERDICT_SCHEMA_NOTE = '结构化作答：本次调用已启用结果 JSON Schema，最终结论必须落在 verdict 字段（只能是 "PASS" 或 "FAIL"，用大写），并在 reason 字段用一句话说明依据。';

	async function runVerifyRound({ verifiers, roundNo, objective, args, exec, lastVerifyOutput, commandSection }) {
		const vRuns = await Promise.all(verifiers.map(async (v) => {
			// The protocol line always ends the tasksheet: it is what the verdict
			// parser reads, so truncation must never be what removes it.
			const body = roundNo === 1
				? [
					`验收指令：${boundedText('验收指令过长，已截断', v.prompt)}`,
					`【验收对象】${boundedText('目标过长，已截断', objective, OBJECTIVE_BUDGET)}`,
					...(commandSection ?? []),
				]
				: [
					`上一轮验收未通过（第 ${roundNo - 1} 轮）。请重新验证并回报结论。`,
					'【上一轮验证输出（可能被截断，优先看失败项）】',
					boundedBoth('优先看失败项，结论与失败清单通常在末尾', lastVerifyOutput, 6000),
					`原验收指令：${boundedText('验收指令过长，已截断', v.prompt)}`,
				];
			const vTask = `${body.join('\n')}\n\n验收纪律：先运行验收命令拿到统计与失败清单；若有失败，如实给 FAIL 和失败清单即可，不要深挖根因（那是修复狼的工作），也不要在工作目录留下诊断文件；务必留出时间在结尾输出协议行。\n\n${VERDICT_LINE}`;
			const vRun = await settleOne(v.agent, boundedTask('验收', vTask), {
				cwd: args.cwd,
				timeoutSec: v.timeoutSec ?? args.timeoutSec,
				model: v.model,
				signal: exec?.signal,
				panel: { session: exec?.agent?.session, label: `验收·第${roundNo}轮 (${v.agent})` },
				schema: VERDICT_SCHEMA_WOLF,
				schemaNote: VERDICT_SCHEMA_NOTE,
			});
			// Structured field first (schema-validated by the CLI when it can), the
			// protocol line as fallback for CLIs whose output cannot carry a schema.
			return { agent: v.agent, ...vRun, verdict: verdictOfRun(vRun, 'wolf') };
		}));
		const perVerifier = vRuns.map((r) => `${r.agent} → ${r.verdict}${r.ok ? '' : ` (exit ${r.exitCode ?? '-'})`}`);
		return {
			verdict: vRuns.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL',
			perVerifier: `${vRuns.length} verifier(s): ${perVerifier.join(' | ')}`,
			lastVerifyOutput: vRuns.map((r) => `===== [verifier ${r.agent}] ${r.verdict} =====\n${r.output}`).join('\n\n'),
			runs: vRuns,
		};
	}

	// Returns { verifiers, dropped } or { error }. Never throws: a broken verify
	// spec must still let the wolves' real work be reported.
	function normalizeVerifiers(verify) {
		if (verify == null) return { verifiers: [], dropped: 0 };
		const list = Array.isArray(verify) ? verify : [verify];
		const kept = list.filter((v) => v && typeof v.agent === 'string' && v.agent.trim() && typeof v.prompt === 'string' && v.prompt.trim());
		// An empty array is a caller who meant to verify but sent nothing. That is
		// not the same as omitting verify: it would report passed:true having
		// verified exactly nothing.
		if (list.length === 0) {
			return { error: 'verify was supplied as an empty array — no verification would run, so this is not a pass' };
		}
		// A NON-empty request that normalizes to nothing means the caller meant to
		// verify but every entry was malformed — reporting that as a pass would be
		// a silently green wolf-pack.
		if (kept.length === 0) {
			return {
				error: `verify was supplied but none of its ${list.length} entr${list.length === 1 ? 'y' : 'ies'} is usable — `
					+ 'each needs a non-empty agent and prompt (nothing would be verified)',
			};
		}
		return { verifiers: kept, dropped: list.length - kept.length };
	}

	// Windows caps a command line at 32767 chars; headroom covers the argv quoting
	// the host adds. Oversized tasksheets do not fail loudly — they spawn-fail,
	// which the verify loop reads as FAIL and burns every remaining round.
	const MAX_COMMAND_CHARS = 30000;
	// Quotes can double under Windows quoting rules, so cap task text well below
	// the raw limit. CHAR_BUDGET bounds prompt/objective content only; the framing
	// of a fully built tasksheet is measured against MAX_COMMAND_CHARS.
	// The objective is shared context repeated in EVERY tasksheet (wolves,
	// verifiers, fix rounds) — capping it keeps a verbose objective from
	// crowding the role-specific prompt out of the command-line budget.
	const OBJECTIVE_BUDGET = 6000;
	const CHAR_BUDGET = 16000;

	function boundedText(label, text, maxChars = CHAR_BUDGET) {
		const s = String(text ?? '');
		if (s.length <= maxChars) return s;
		return s.slice(0, maxChars)
			+ `\n\n[此段已被截断：原文 ${s.length} 字符，上限 ${maxChars}；${label}]`;
	}

	// Verification output puts its verdict line and failing-case summary at the
	// end, so the head-only cut above is the wrong shape for it: keep both ends.
	function boundedBoth(label, text, maxChars) {
		const s = String(text ?? '');
		if (s.length <= maxChars) return s;
		const notice = `\n\n[中段已截断：原文 ${s.length} 字符，上限 ${maxChars}；${label}]\n\n`;
		const keepTail = Math.min(Math.floor(maxChars / 3), (maxChars - notice.length) >> 1);
		const keepHead = maxChars - notice.length - keepTail;
		return s.slice(0, keepHead) + notice + s.slice(-keepTail);
	}

	// Truncation must never eat the protocol line at the tail (WOLF_VERDICT /
	// REVIEW_VERDICT): a cut-off verdict reads as "missing" and fails every round.
	// Keep head + tail, drop the middle, and say so.
	function boundedTask(label, text) {
		const s = String(text ?? '');
		if (s.length <= MAX_COMMAND_CHARS) return s;
		const notice = `\n\n[任务书中部已截断：原文 ${s.length} 字符，超过命令行安全长度 ${MAX_COMMAND_CHARS}；${label}请据此执行]\n\n`;
		const keepTail = Math.min(2000, Math.floor((MAX_COMMAND_CHARS - notice.length) / 3));
		const keepHead = MAX_COMMAND_CHARS - notice.length - keepTail;
		return s.slice(0, keepHead) + notice + s.slice(-keepTail);
	}

	function summarizeWorkers(workers, perWorkerChars) {
		return workers.map((w) => [
			`===== [${w.label}] ${w.agent} — ${w.ok ? 'ok' : `FAILED${w.timedOut ? ' (timeout)' : ''}${w.error ? ` (${w.error})` : ''}`} =====`,
			tail(w.output ?? '', perWorkerChars),
		].join('\n')).join('\n\n');
	}

	// ---------- artifact chain (AI-native SDLC) ----------
	// The artifact directory IS the audit trail: every run writes its manifest,
	// per-worker tasksheets+outputs, verify rounds and the final verdict, so the
	// next goal round (or a human) can resume from artifacts instead of memory.
	// Archive failures degrade to a phase-log note — they must never fail a run
	// whose wolves actually succeeded.
	const safeSlug = (text) => String(text ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32) || 'run';
	const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

	async function writeArtifactFile(root, rel, text) {
		const abs = path.join(root, rel);
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, text, 'utf8');
	}

	async function writeWolfArtifacts(root, data) {
		const manifest = {
			tool: 'pack_wolf', build: BUILD, objective: data.objective,
			startedAt: data.startedAt, finishedAt: new Date().toISOString(),
			cwd: data.cwd ?? null, config: data.config ?? {},
			result: {
				passed: data.result.passed, verdict: data.result.verdict,
				verifyRounds: data.result.verifyRounds,
			},
		};
		await writeArtifactFile(root, 'manifest.json', JSON.stringify(manifest, null, 2));
		for (const [i, w] of (data.workers ?? []).entries()) {
			await writeArtifactFile(root, `workers/${String(i + 1).padStart(2, '0')}-${safeSlug(w.label)}.md`, [
				`# wolf ${w.label} (${w.agent})`, '',
				`- ok: ${w.ok}`, `- exitCode: ${w.exitCode ?? '-'}`,
				`- timedOut: ${!!w.timedOut}`, `- durationMs: ${w.durationMs ?? 0}`, '',
				'## tasksheet', '', w.tasksheet ?? '(unavailable)', '',
				'## output', '', w.output ?? '',
			].join('\n'));
		}
		for (const [i, r] of (data.verifyRounds ?? []).entries()) {
			await writeArtifactFile(root, `verify/round-${r.round ?? i + 1}.md`, [
				`# verify round ${r.round ?? i + 1}`, '', r.perVerifier ?? '', '',
				'## output', '', r.output ?? '',
			].join('\n'));
		}
		await writeArtifactFile(root, 'phase-log.md',
			(data.phaseLog ?? []).map((p) => `- ${p.phase}: ${p.summary}`).join('\n'));
		await writeArtifactFile(root, 'verdict.md', [
			'# verdict', '',
			`- passed: ${data.result.passed}`, `- verdict: ${data.result.verdict}`,
			`- verifyRounds: ${data.result.verifyRounds}`, '',
			'## last verify output', '',
			tail(data.result.lastVerifyOutput ?? '', cfg.maxOutputChars),
		].join('\n'));
	}

	async function writeSwarmArtifacts(root, data) {
		const manifest = {
			tool: 'pack_swarm', build: BUILD, objective: data.objective,
			startedAt: data.startedAt, finishedAt: new Date().toISOString(),
			cwd: data.cwd ?? null,
			dispatched: (data.workers ?? []).length,
			succeeded: (data.workers ?? []).filter((w) => w.ok).length,
		};
		await writeArtifactFile(root, 'manifest.json', JSON.stringify(manifest, null, 2));
		for (const [i, w] of (data.workers ?? []).entries()) {
			await writeArtifactFile(root, `reports/${String(i + 1).padStart(2, '0')}-${safeSlug(w.label)}.md`, [
				`# bee ${w.label} (${w.agent})`, '',
				`- ok: ${w.ok}`, `- exitCode: ${w.exitCode ?? '-'}`,
				`- timedOut: ${!!w.timedOut}`, `- durationMs: ${w.durationMs ?? 0}`, '',
				'## tasksheet', '', w.tasksheet ?? '(unavailable)', '',
				'## report', '', w.output ?? '',
			].join('\n'));
		}
	}

	async function writeEvalArtifacts(root, data) {
		const manifest = {
			tool: 'pack_eval', build: BUILD,
			startedAt: data.startedAt, finishedAt: new Date().toISOString(),
			cwd: data.cwd ?? null, suite: data.suite ?? null,
			result: { total: data.result.total, passed: data.result.passed, failed: data.result.failed },
		};
		await writeArtifactFile(root, 'manifest.json', JSON.stringify(manifest, null, 2));
		for (const [i, c] of (data.cases ?? []).entries()) {
			await writeArtifactFile(root, `cases/${String(i + 1).padStart(2, '0')}-${safeSlug(c.id)}.md`, [
				`# eval ${c.id} (${c.agent})`, '',
				`- pass: ${c.pass}`, `- exitCode: ${c.exitCode ?? '-'}`,
				`- timedOut: ${!!c.timedOut}`, `- durationMs: ${c.durationMs ?? 0}`, '',
				...(c.problems?.length ? ['## problems', '', ...c.problems.map((p) => `- ${p}`), ''] : []),
				'## prompt', '', c.prompt ?? '', '',
				'## output', '', c.output ?? '',
			].join('\n'));
		}
	}

	// ---------- task ledger（自动接·自动续的基础） ----------
	// One JSON file per workspace: <cwd>/.agent-pack/ledger.json. Every wolf/swarm
	// run appends an entry with a FULL SNAPSHOT OF ITS ARGS at start, so a fresh
	// session (new process, no memory) can re-dispatch the same task verbatim.
	// Crash/interrupt detection: a 'running' entry older than LEDGER_STALE_SEC is
	// swept to 'interrupted' on read — the args snapshot is what makes it resumable.
	const LEDGER_KEEP = 200;
	const LEDGER_STALE_SEC = 6 * 3600;
	const ledgerFileOf = (cwd) => path.join(cwd || os.tmpdir(), '.agent-pack', 'ledger.json');
	const packImpls = {}; // kind -> impl fn, filled at registration time so pack_resume can re-dispatch in-process

	async function ledgerReadSwept(dirRoot) {
		const file = path.join(dirRoot, 'ledger.json');
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
				e.error = `swept: 'running' for over ${LEDGER_STALE_SEC / 3600}h with no completion record`;
			}
		}
		return entries;
	}

	async function ledgerUpsert(dirRoot, entry) {
		const file = path.join(dirRoot, 'ledger.json');
		const entries = await ledgerReadSwept(dirRoot);
		const i = entries.findIndex((e) => e.id === entry.id);
		if (i >= 0) entries[i] = { ...entries[i], ...entry };
		else entries.push(entry);
		const trimmed = entries.slice(-LEDGER_KEEP);
		await mkdir(dirRoot, { recursive: true });
		// Atomic replace: a process killed mid-write must never leave a truncated
		// (unparseable) ledger — that is exactly the crash scenario resumability
		// exists for. Write to a temp file, then rename over the real one.
		const tmpFile = `${file}.tmp`;
		await writeFile(tmpFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: trimmed }, null, 2), 'utf8');
		fs.renameSync(tmpFile, file);
	}

	/** Wrap a wolf/swarm implementation: ledger BEGIN before, terminal status
	 * after. A throw records 'failed'; a killed process leaves 'running' which
	 * the stale sweep later flips to 'interrupted' — both are resumable states. */
	async function ledgerRun(kind, args, exec, impl) {
		const dirRoot = path.join(args.cwd || os.tmpdir(), '.agent-pack');
		const id = `t-${stamp().replace(/:/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
		const entry = {
			id, kind, tool: `pack_${kind}`, objective: String(args.objective ?? ''),
			cwd: args.cwd ?? null, startedAt: new Date().toISOString(), finishedAt: null,
			status: 'running', resumedFrom: args.__resumedFrom ?? null,
			args: JSON.parse(JSON.stringify(args)), // full snapshot for resume
		};
		try { await ledgerUpsert(dirRoot, entry); } catch { /* ledger trouble must never block a run */ }
		try {
			const result = await impl(args, exec);
			const done = { id, finishedAt: new Date().toISOString(), status: 'completed' };
			if (kind === 'wolf') { done.verdict = result.verdict; done.passed = result.passed; done.verifyRounds = result.verifyRounds; }
			else { done.succeeded = result.succeeded; done.dispatched = result.dispatched; }
			if (result?.artifactDir) done.artifactDir = result.artifactDir;
			try { await ledgerUpsert(dirRoot, done); } catch { /* ditto */ }
			return result;
		} catch (error) {
			try {
				await ledgerUpsert(dirRoot, { id, finishedAt: new Date().toISOString(), status: 'failed', error: String(error?.message ?? error) });
			} catch { /* ditto */ }
			throw error;
		}
	}

	// ---------- tool schemas ----------
	// All enforced-subset JSON Schema (see note at the schema helpers above).
	const beeItem = objSchema({
		label: str('Short bee label, e.g. "market-scan".'),
		agent: str('Agent CLI name from the registry.'),
		prompt: str("This bee's full research prompt (its angle)."),
		model: str('Optional model override.'),
	}, ['label', 'agent', 'prompt']);

	const wolfItem = objSchema({
		role: str('e.g. db / api / frontend / test / docs.'),
		agent: str('Agent CLI name from the registry.'),
		prompt: str("This wolf's full task prompt (keep file scopes disjoint between wolves)."),
		model: str('Optional model override.'),
	}, ['role', 'agent', 'prompt']);

	const verifyItem = objSchema({
		agent: str('Agent CLI to run verification. Use a DIFFERENT agent family than the implementers for heterogeneous review.'),
		prompt: str('Verification prompt; it must instruct the agent to end with WOLF_VERDICT: PASS or FAIL.'),
		timeoutSec: int('Verification timeout override.'),
		model: str('Optional model override.'),
	}, ['agent', 'prompt']);

	// `verify` accepts one verifier object or an array of them; normalizeVerifiers()
	// flattens both shapes so the tool never has to know which was supplied, and
	// `oneOf` states both shapes in the schema instead of lying about the type.
	const verifySpec = {
		oneOf: [
			{
				type: 'object', description: 'A single verifier.',
				additionalProperties: false, properties: { ...verifyItem.properties }, required: [...verifyItem.required],
			},
			{
				type: 'array',
				description: 'Several verifiers: every one must PASS (heterogeneous verify).',
				items: {
					type: 'object',
					additionalProperties: false, properties: { ...verifyItem.properties }, required: [...verifyItem.required],
				},
			},
		],
		description: 'One verifier {agent,prompt,timeoutSec?,model?}, or an array of them for heterogeneous review (all must PASS).',
	};

	const phaseItem = objSchema({
		phase: str('Loop phase name.'),
		summary: str('One-line summary of the phase.'),
	}, ['phase', 'summary']);

	// ---------- tools ----------
	const registration = (tool) => ctx.tools.register(tool);

	registration({
		name: 'pack_registry_scan',
		description: 'Discover the agent CLIs actually installed on this machine (PATH plus npm/bun/python/scoop global bins — not just a fixed list), probe health via --version, and persist capability profiles to the agent-pack registry. Presets cover the CLIs whose argv shape is known; anything else it finds is recorded with its binary path and NO template (this plugin will not guess how a CLI takes its prompt) — declare one in config.templates to make it dispatchable. Keeps manual overrides and measured evidence. Run this first before dispatching.',
		parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		output: {
			schema: objSchema({
				scannedAt: str('ISO timestamp of this scan.'),
				build: str('Which build of this plugin is loaded (proves the running code is current).'),
				dispatchableCount: int('How many agents can be dispatched right now.'),
				agents: {
					type: 'array',
					items: objSchema({
						name: str('Agent name.'),
						kind: str('Profile kind (coding/research/media).'),
						health: str('ok / absent / broken / not-on-path / native-mcp.'),
						versionLine: str('First line of --version output.'),
						dispatchable: bool('Whether a dispatch template exists and the CLI answered.'),
						discoveredBy: str('preset / scan / config / manual — where this entry came from.'),
						bin: str('Binary path, when discovery found one (omitted for presets found on PATH).'),
						note: str('Human note (why it is not dispatchable, or how it behaves).'),
					}, ['name', 'kind', 'health', 'versionLine', 'dispatchable', 'discoveredBy']),
				},
			}, ['scannedAt', 'build', 'dispatchableCount', 'agents']),
			render: (_args, value) => {
				const ready = value.agents.filter((a) => a.dispatchable);
				const untemplated = value.agents.filter((a) => !a.dispatchable && a.health === 'ok');
				const offPath = value.agents.filter((a) => a.health === 'not-on-path');
				const broken = value.agents.filter((a) => a.health === 'broken');
				const absent = value.agents.filter((a) => a.health === 'absent');
				const sections = [];
				sections.push(`Scanned ${value.agents.length} profiles at ${value.scannedAt}. [build ${value.build}]`);
				sections.push(`Dispatchable now (${ready.length}): ` + (ready.map((a) => `${a.name}${a.versionLine ? ` (${a.versionLine})` : ''}`).join(', ') || 'none'));
				if (untemplated.length > 0) {
					sections.push(`Discovered but NOT dispatchable — no template, and this plugin will not guess one (${untemplated.length}):\n`
						+ untemplated.map((a) => `  - ${a.name}${a.bin ? ` at ${a.bin}` : ''}${a.versionLine ? ` — ${a.versionLine}` : ''}`).join('\n')
						+ '\n  → declare {"<name>": ["<cli>", "{prompt}"]} in config.templates to enable it.');
				}
				if (offPath.length > 0) {
					sections.push(`Discovered but off PATH — add their directory to PATH to use them (${offPath.length}):\n`
						+ offPath.map((a) => `  - ${a.name} → ${a.bin ?? '?'}`).join('\n'));
				}
				if (broken.length > 0) sections.push(`Broken (${broken.length}): ` + broken.map((a) => `${a.name} — ${a.versionLine}`).join('; '));
				if (absent.length > 0) sections.push(`Not installed (${absent.length}): ` + absent.map((a) => a.name).join(', '));
				return [{ type: 'text', text: sections.join('\n\n') }];
			},
		},
		async execute() {
			const registry = await scanRegistry();
			const agents = Object.values(registry.agents).map((a) => {
				const value = {
					name: a.name, kind: a.kind ?? 'coding', health: a.health ?? 'absent',
					versionLine: a.versionLine ?? '', dispatchable: dispatchable(a),
					discoveredBy: a.discoveredBy ?? (a.manual ? 'manual' : 'preset'),
				};
				if (a.bin) value.bin = a.bin;
				if (a.note) value.note = a.note;
				return value;
			});
			return {
				scannedAt: registry.scannedAt,
				build: BUILD,
				dispatchableCount: agents.filter((a) => a.dispatchable).length,
				agents,
			};
		},
		presentCall: () => ({ card: 'generic', title: 'Scan agent CLI registry', kind: 'other' }),
	});

	registration({
		name: 'pack_registry_list',
		description: 'Show the current agent-pack registry: each discovered agent CLI, its source (preset/scan/config), health, whether it is dispatchable, capability scores (prior vs measured), and its dispatch argv template. Read-only.',
		parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
		output: {
			schema: objSchema({
				registryText: str('Human-readable registry dump.'),
			}, ['registryText']),
			render: (_args, value) => [{ type: 'text', text: value.registryText }],
		},
		async execute() {
			const registry = await readRegistry();
			const lines = Object.values(registry.agents ?? {}).map((a) => {
				const measured = measuredLine(a);
				const ready = dispatchable(a);
				const prior = a.scores
					? `${JSON.stringify(a.scores)} (prior — hand-written, untested)`
					: 'none (discovered, never scored — routing uses measured evidence only)';
				return [
					`${a.name} [${a.kind ?? '?'}] health=${a.health ?? '?'}${a.manual ? ' (manual)' : ''}`
						+ ` ${ready ? 'DISPATCHABLE' : 'not dispatchable'} source=${a.discoveredBy ?? 'preset'}`,
					`  version: ${a.versionLine || '-'}`,
					...(a.bin ? [`  bin: ${a.bin}`] : []),
					...(a.note ? [`  note: ${a.note}`] : []),
					`  scores: ${prior}`,
					// Routing prefers these over the prior, so they must be visible.
					...(measured ? [`  measured: ${measured}`] : []),
					`  template: ${Array.isArray(a.template) ? a.template.join(' ') : String(a.template)}`,
				].join('\n');
			});
			return { registryText: lines.join('\n') || '(registry empty — run pack_registry_scan)' };
		},
		presentCall: () => ({ card: 'generic', title: 'List agent registry', kind: 'other' }),
	});

	registration({
		name: 'pack_dispatch',
		description: 'Run ONE locally installed agent CLI headlessly with a task prompt and return its output. Use pack_registry_scan/list first to pick an agent. Long-running: returns when the CLI exits or the timeout fires.',
		parameters: objSchema({
			agent: str('Agent CLI name from the registry (e.g. codex, opencode).'),
			task: str('Full task prompt for the agent.'),
			cwd: str('Working directory for the run (absolute path).'),
			timeoutSec: int('Kill after this many seconds (default from config).'),
			model: str("Optional model override passed via the agent's modelArgs template."),
		}, ['agent', 'task']),
		output: {
			schema: objSchema({
				agent: str('Agent name.'),
				ok: bool('Whether the CLI exited 0 without timeout/spawn error.'),
				exitCode: int('Process exit code (omitted when null, e.g. timeout).'),
				timedOut: bool('Whether the run hit the timeout.'),
				durationMs: int('Wall-clock duration.'),
				output: str('Collected output (stdout preferred, stderr fallback).'),
				spawnError: str('Spawn failure detail when the process never started.'),
				usage: str('Token/cost spend parsed from the CLI output, when it reports one.'),
			}, ['agent', 'ok', 'timedOut', 'durationMs', 'output']),
			render: (_args, value) => [{
				type: 'text',
				text: `[${value.agent}] ${value.ok ? 'ok' : `FAILED (exit ${value.exitCode ?? '-'}${value.timedOut ? ', timed out' : ''})`} in ${Math.round(value.durationMs / 1000)}s${value.spawnError ? `\nspawn error: ${value.spawnError}` : ''}${value.usage ? `\n${value.usage}` : ''}\n${value.output}`,
			}],
		},
		async execute(args, exec) {
			if (!args.task || args.task.length > cfg.maxPromptChars) {
				throw new Error(`task required and must be <= ${cfg.maxPromptChars} chars`);
			}
			const run = await settleOne(args.agent, args.task, {
				cwd: args.cwd, timeoutSec: args.timeoutSec, model: args.model, signal: exec?.signal,
				panel: { session: exec?.agent?.session, label: `派发 (${args.agent})` },
			});
			const value = {
				agent: run.agent, ok: run.ok, timedOut: run.timedOut,
				durationMs: run.durationMs, output: run.output,
			};
			if (run.exitCode != null) value.exitCode = run.exitCode;
			if (run.spawnError) value.spawnError = run.spawnError;
			if (run.usage) value.usage = usageLine(sumUsage([run]));
			return value;
		},
		presentCall: (args) => ({ card: 'generic', title: `Dispatch ${args.agent}`, kind: 'other', rawInput: { agent: args.agent, cwd: args.cwd } }),
	});

	registration({
		name: 'pack_swarm',
		description: 'SWARM research mode (蜂群): dispatch several worker agent CLIs in PARALLEL, each with its own research angle prompt, and return all reports merged for the queen (you) to synthesize. You are the queen: write a distinct prompt per bee; the plugin only fans out and collects.',
		parameters: objSchema({
			objective: str('The research objective all bees serve.'),
			bees: { type: 'array', items: beeItem, description: `One entry per bee, at most ${cfg.maxWorkers}.` },
			cwd: str('Working directory for all bees.'),
			timeoutSec: int('Per-bee timeout in seconds.'),
			context: { type: 'array', items: str('A context file path.'), description: 'Project context files (repo-relative or absolute) injected into every tasksheet as a read-first list; missing paths are flagged as missing.' },
			artifact: bool('Write the run archive (manifest + per-bee tasksheets and reports) under <cwd>/.agent-pack/<timestamp>-<slug>/ and return its path.'),
		}, ['objective', 'bees']),
		output: {
			schema: objSchema({
				objective: str('The research objective.'),
				dispatched: int('Number of bees dispatched.'),
				succeeded: int('Number of bees that returned ok.'),
				combined: str('All bee reports merged, labeled per bee.'),
				usage: str('Token/cost spend summed over all bees, when their CLIs report one.'),
				artifactDir: str('Directory holding the run archive (manifest.json + reports/). Present only when artifact=true.'),
				artifactError: str('Archive write failure detail, when artifact=true but the archive could not be written.'),
			}, ['objective', 'dispatched', 'succeeded', 'combined']),
			render: (_args, value) => [{
				type: 'text',
				text: `Swarm: ${value.succeeded}/${value.dispatched} bees returned for "${value.objective}".${value.usage ? `\n${value.usage}` : ''}${value.artifactDir ? `\nArtifacts: ${value.artifactDir}` : ''}\n\n${value.combined}`,
			}],
		},
		execute(args, exec) { return ledgerRun('swarm', args, exec, packImpls.swarm); },
		_impl: (packImpls.swarm = async (args, exec) => {
			const bees = Array.isArray(args.bees) ? args.bees : [];
			if (bees.length === 0) throw new Error('bees[] must contain at least one entry');
			if (bees.length > cfg.maxWorkers) throw new Error(`at most ${cfg.maxWorkers} bees per swarm (got ${bees.length})`);
			for (const bee of bees) {
				if (!bee?.agent || !bee?.prompt) throw new Error('each bee needs agent+prompt');
				// The tasksheet budget is CHAR_BUDGET, so validating against anything
				// larger would admit prompts that are then silently truncated.
				if (bee.prompt.length > CHAR_BUDGET) throw new Error(`bee "${bee.label ?? bee.agent}" prompt exceeds ${CHAR_BUDGET} chars (the tasksheet budget)`);
			}
			const startedAt = new Date().toISOString();
			const workers = await Promise.all(bees.map((bee) => runWorker(bee, args.objective, {
				cwd: args.cwd, timeoutSec: args.timeoutSec, signal: exec?.signal, mode: 'swarm', context: args.context,
				panelSession: exec?.agent?.session,
			})));
			const succeeded = workers.filter((w) => w.ok).length;
			const perWorkerChars = Math.max(3000, Math.floor(cfg.maxOutputChars / Math.max(1, workers.length)));
			let artifactDir = null;
			let artifactError = null;
			if (args.artifact) {
				const root = path.join(args.cwd || os.tmpdir(), '.agent-pack', `${stamp()}-swarm-${safeSlug(args.objective)}`);
				try {
					await writeSwarmArtifacts(root, { objective: args.objective, startedAt, cwd: args.cwd ?? null, workers });
					artifactDir = root;
				} catch (error) {
					// never fail a successful swarm over archive trouble — surface it instead
					artifactError = `archive write failed: ${String(error?.message ?? error)}`;
				}
			}
			return {
				objective: args.objective,
				dispatched: workers.length,
				succeeded,
				combined: summarizeWorkers(workers, perWorkerChars),
				...(sumUsage(workers) ? { usage: usageLine(sumUsage(workers)) } : {}),
				...(artifactDir ? { artifactDir } : {}),
				...(artifactError ? { artifactError } : {}),
			};
		}),
		presentCall: (args) => ({ card: 'generic', title: `Swarm ×${args.bees?.length ?? 0}`, kind: 'other', rawInput: { objective: args.objective } }),
	});

	registration({
		name: 'pack_wolf',
		description: "WOLF-PACK implementation mode (狼群): dispatch role wolves (db/api/frontend/test/…) in PARALLEL in the same workspace, then run a verify wolf that MUST end its output with a final line `WOLF_VERDICT: PASS` or `WOLF_VERDICT: FAIL`. On FAIL the plugin re-dispatches fix rounds (to the fixer or all non-verify wolves with the verify output attached) until PASS or maxFixRounds. You are the king: assign roles and write each wolf's prompt. Optional deterministic gates: verifyCommand (argv array run after implement; green = command-verified verdict when no LLM verifier), frozen paths (fix rounds must not modify them — size+mtime gate, violation = frozen-violation verdict), context files injected read-first into every tasksheet, artifact:true writes the audit archive.",
		parameters: objSchema({
			objective: str('The implementation objective.'),
			wolves: { type: 'array', items: wolfItem, description: `One entry per wolf, at most ${cfg.maxWorkers}.` },
			verify: verifySpec,
			verifyCommand: { type: 'array', items: str('One argv element.'), description: 'Deterministic verification command as an argv ARRAY (never a shell string), e.g. ["node","--test"]. Run after the implement phase; its result is embedded into the first verify round and decides the verdict when no LLM verifier is supplied.' },
			frozen: { type: 'array', items: str('A repo-relative path.'), description: 'Paths the FIX rounds must not modify (deterministic gate): snapshotted after implement, compared after every fix round; any change fails the pack with verdict frozen-violation. Use it to protect the acceptance tests during repair.' },
			maxFixRounds: int('Fix-round budget after a FAIL (default 2, hard cap 5).'),
			cwd: str('Shared workspace directory for all wolves.'),
			timeoutSec: int('Per-run timeout in seconds.'),
			context: { type: 'array', items: str('A context file path.'), description: 'Project context files (repo-relative or absolute) injected into every tasksheet as a read-first list; missing paths are flagged as missing.' },
			artifact: bool('Write the audit archive (manifest.json, workers/, verify/, phase-log.md, verdict.md) under <cwd>/.agent-pack/<timestamp>-wolf-<slug>/ and return its path.'),
		}, ['objective', 'wolves']),
		output: {
			schema: objSchema({
				objective: str('The implementation objective.'),
				passed: bool('Whether the final verify passed (LLM verdict PASS or a green verifyCommand with no LLM verifier). Always false when nothing verified.'),
				verifyRounds: int('Number of LLM verify rounds run (0 when only verifyCommand judged).'),
				verdict: str('PASS / FAIL / missing / invalid-verify / not-run (nothing verified) / command-verified (verifyCommand green, no LLM verifier) / command-failed (verifyCommand red, no LLM verifier) / frozen-violation (a fix round modified a frozen path).'),
				phaseLog: { type: 'array', items: phaseItem },
				lastVerifyOutput: str('Output of the last verification round.'),
				usage: str('Token/cost spend summed over every wolf and verifier run in this pack, when the CLIs report one.'),
				artifactDir: str('Directory holding the audit archive. Present only when artifact=true.'),
				artifactError: str('Archive write failure detail, when artifact=true but the archive could not be written.'),
			}, ['objective', 'passed', 'verifyRounds', 'verdict', 'phaseLog', 'lastVerifyOutput']),
			render: (_args, value) => [{
				type: 'text',
				text: `Wolf-pack "${value.objective}": ${value.verdict === 'not-run' ? 'NOT VERIFIED (no verifier supplied — wolves ran unverified)'
					: value.passed && value.verdict === 'command-verified' ? 'VERIFIED PASS (command-verified: the deterministic verify command exited 0; no LLM verifier ran)'
					: value.passed ? 'VERIFIED PASS'
					: `NOT verified (verdict: ${value.verdict}, rounds: ${value.verifyRounds})`}\n`
					+ value.phaseLog.map((p) => `- ${p.phase}: ${p.summary}`).join('\n')
					+ (value.usage ? `\n${value.usage}` : '')
					+ (value.artifactDir ? `\nArtifacts: ${value.artifactDir}` : '')
					+ (value.artifactError ? `\nArtifact error: ${value.artifactError}` : '')
					+ `\n\n[last verify output]\n${value.lastVerifyOutput}`,
			}],
		},
		execute(args, exec) { return ledgerRun('wolf', args, exec, packImpls.wolf); },
		_impl: (packImpls.wolf = async (args, exec) => {
			const wolves = Array.isArray(args.wolves) ? args.wolves : [];
			if (wolves.length === 0) throw new Error('wolves[] must contain at least one entry');
			if (wolves.length > cfg.maxWorkers) throw new Error(`at most ${cfg.maxWorkers} wolves per pack (got ${wolves.length})`);
			for (const w of wolves) {
				if (!w?.agent || !w?.prompt) throw new Error('each wolf needs agent+prompt');
				// Same reasoning as the swarm bee check: validate at the budget the
				// tasksheet actually delivers, not at a larger nominal limit.
				if (w.prompt.length > CHAR_BUDGET) throw new Error(`wolf "${w.role ?? w.agent}" prompt exceeds ${CHAR_BUDGET} chars (the tasksheet budget)`);
			}
			const fixRounds = Math.min(Math.max(args.maxFixRounds ?? 2, 0), 5);
			const startedAt = new Date().toISOString();
			const phaseLog = [];
			// A verifier may be supplied but unusable. That is never a pass: it means
			// nobody verified while the caller believed a verification happened. The
			// text goes into the result instead of a throw so the wolves' real work
			// is still reported.
			let verifierError = null;
			let verifiers = [];
			let droppedVerifiers = 0;
			const normalized = normalizeVerifiers(args.verify);
			if (normalized.error) verifierError = normalized.error;
			else {
				verifiers = normalized.verifiers;
				droppedVerifiers = normalized.dropped;
			}
			if (verifiers.length > cfg.maxWorkers) {
				throw new Error(`at most ${cfg.maxWorkers} verifiers per round (got ${verifiers.length}) — `
					+ 'each one is a full CLI process launched in parallel');
			}
			// A partially malformed verify list silently weakens the review; say so
			// where the caller will read it.
			if (droppedVerifiers > 0) {
				phaseLog.push({
					phase: 'verify',
					summary: `${droppedVerifiers} malformed verifier(s) dropped — only ${verifiers.length} will actually run`,
				});
			}
			const implement = await Promise.all(wolves.map((w) => runWorker(w, args.objective, {
				cwd: args.cwd, timeoutSec: args.timeoutSec, signal: exec?.signal, mode: 'wolf', context: args.context,
				panelSession: exec?.agent?.session,
			})));
			const implementOk = implement.filter((w) => w.ok).length;
			phaseLog.push({
				phase: 'implement',
				summary: `${implementOk}/${implement.length} wolves ok — ` + implement.map((w) => `${w.label}:${w.ok ? 'ok' : failWhy(w)}`).join(', '),
			});

			// Deterministic gate (AI-native SDLC): run the caller's verifyCommand
			// BEFORE any LLM verifier spends tokens. Its result is fact, embedded
			// into the first verify round; with no LLM verifier it IS the verdict.
			let commandReport = null;
			if (Array.isArray(args.verifyCommand) && args.verifyCommand.length > 0) {
				commandReport = await runPlainCommand(args.verifyCommand, { cwd: args.cwd, timeoutSec: args.timeoutSec, signal: exec?.signal });
				phaseLog.push({
					phase: 'verify-command',
					summary: `${JSON.stringify(args.verifyCommand)} → ${commandReport.ok ? 'ok' : 'FAILED'}`
						+ ` (exit ${commandReport.exitCode ?? '-'}${commandReport.timedOut ? ', timed out' : ''})`
						+ ` in ${Math.round(commandReport.durationMs / 1000)}s`
						+ (commandReport.spawnError ? ` — ${commandReport.spawnError}` : ''),
				});
			}
			// Facts the LLM verifier starts from (round 1 only — later rounds inherit
			// the story through lastVerifyOutput).
			const commandSection = commandReport ? [
				'确定性验收命令已先行运行（以下是事实基线，直接采用，不要靠猜）：',
				`- 命令：${JSON.stringify(args.verifyCommand)}`,
				`- 结果：${commandReport.ok ? 'exit 0（绿）' : `exit ${commandReport.exitCode ?? '-'}（红）${commandReport.timedOut ? '，且被超时掐断' : ''}`}`,
				'- 输出尾部：',
				boundedBoth('命令输出尾部', commandReport.output ?? '', 2000),
			] : null;

			// Frozen-path gate: snapshot AFTER implement (implement wolves may
			// legitimately create the acceptance tests), compare after every fix
			// round — the repair step must not rewrite what acceptance depends on.
			const frozenPaths = Array.isArray(args.frozen) ? args.frozen.map(String) : [];
			const frozenSnapshot = frozenPaths.length > 0 ? snapshotFrozen(args.cwd, frozenPaths) : null;
			if (frozenSnapshot) {
				phaseLog.push({ phase: 'frozen', summary: `guarding ${frozenPaths.length} path(s) across fix rounds: ${frozenPaths.join(', ')}` });
			}

			// No verifier ever ran => nothing was verified. Starting at true would
			// render an unverified pack as "VERIFIED PASS" — the exact silent-green
			// failure the invalid-verify guard exists to prevent.
			let passed = false;
			let verdict = 'not-run';
			let verifyRounds = 0;
			if (verifierError) {
				passed = false;
				verdict = 'invalid-verify';
				phaseLog.push({ phase: 'verify', summary: `NOT RUN — ${verifierError}` });
			}
			let aborted = false;
			let lastVerifyOutput = verifierError ? `验收未执行：${verifierError}` : '';
			const verifyRoundsLog = [];
			const fixRunAll = [];
			// Every run that touched this pack, for the token/cost tally: implement +
			// fix + verify. Collecting it here (not at the end) keeps the archive and
			// the tool result reporting the same number.
			const verifyRunAll = [];
			// Fix rounds only ever go to the fixers, so "no fixer left" means a FAIL
			// can never be repaired — say so instead of burning identical rounds.
			const fixers = wolves.filter((w) => (w.role ?? '').toLowerCase() !== 'test');
			while (verifiers.length > 0 && verifyRounds <= fixRounds) {
				// Aborting the tool call must stop the loop, not just the current spawn.
				if (exec?.signal?.aborted) {
					aborted = true;
					phaseLog.push({ phase: 'aborted', summary: `caller aborted after ${verifyRounds} verify round(s)` });
					break;
				}
				const roundNo = verifyRounds + 1;
				const judged = await runVerifyRound({ verifiers, roundNo, objective: args.objective, args, exec, lastVerifyOutput, commandSection });
				verifyRounds = roundNo;
				lastVerifyOutput = judged.lastVerifyOutput;
				verdict = judged.verdict;
				passed = judged.verdict === 'PASS';
				verifyRoundsLog.push({ round: roundNo, perVerifier: judged.perVerifier, output: judged.lastVerifyOutput });
				verifyRunAll.push(...(judged.runs ?? []));
				phaseLog.push({
					phase: `verify-${roundNo}`,
					summary: judged.perVerifier + ` → ${verdict}`,
				});
				if (passed || roundNo > fixRounds) break;
				// The abort may have arrived while this verify round was running.
				if (exec?.signal?.aborted) {
					aborted = true;
					phaseLog.push({ phase: 'aborted', summary: `caller aborted during verify-${roundNo}; fix round skipped` });
					break;
				}
				if (fixers.length === 0) {
					phaseLog.push({ phase: `fix-${roundNo}`, summary: 'skipped: every wolf is a test role, no fixer to re-dispatch' });
					break;
				}
				// The composed fix prompt is already budgeted (6k verify output + the
				// wolf's own tasksheet); passing FIX_PROMPT_BUDGET keeps runWorker from
				// re-cutting it at the smaller default and losing the constraints.
				const FIX_PROMPT_BUDGET = CHAR_BUDGET + 6000;
				const fixRun = await Promise.all(fixers.map((w) => runWorker({
					...w,
					prompt: [
						'上一轮实现未通过验收。请只修复你负责的部分。',
						'先复现失败再动手。若失败源于测试文件自身的错误断言（如注释与断言不一致、期望值算错），修正测试文件也是合法修法；但不得删除测试或放松其实质约束来换取通过。',
						...(frozenPaths.length > 0 ? [`以下路径被调用方冻结，本轮修复绝对不得创建、修改或删除：${frozenPaths.join('、')}。`] : []),
						'【验收输出（可能被截断，优先读失败项）】',
						boundedBoth('优先读失败项，结论通常在末尾', lastVerifyOutput, 6000),
						'',
						'你原来的任务书：',
						boundedText('任务书过长，已截断', w.prompt, CHAR_BUDGET),
					].join('\n'),
				}, args.objective, {
					cwd: args.cwd, timeoutSec: args.timeoutSec, signal: exec?.signal,
					mode: 'wolf', promptChars: FIX_PROMPT_BUDGET, context: args.context,
					panelSession: exec?.agent?.session,
				})));
				fixRunAll.push(...fixRun);
				phaseLog.push({
					phase: `fix-${roundNo}`,
					summary: fixRun.map((w) => `${w.label}:${w.ok ? 'ok' : failWhy(w)}`).join(', '),
				});
				// Deterministic frozen gate: check the filesystem, not the wolf's word.
				if (frozenSnapshot) {
					const violated = frozenViolations(args.cwd, frozenSnapshot);
					if (violated.length > 0) {
						verdict = 'frozen-violation';
						passed = false;
						phaseLog.push({ phase: 'frozen', summary: `fix-${roundNo} modified frozen path(s): ${violated.join(', ')} — deterministic FAIL` });
						break;
					}
				}
			}
			// Deterministic-only verification: no LLM verifier ran, but a verifyCommand
			// decided. The verdict says WHO verified (a command, not a judge). A
			// malformed verify spec keeps verdict invalid-verify — the caller asked for
			// LLM judgment and did not get it, so the run stays conservatively red.
			if (verifyRounds === 0 && commandReport && !verifierError) {
				verdict = commandReport.ok ? 'command-verified' : 'command-failed';
				passed = commandReport.ok;
			}
			// Cost is part of the result, not a separate investigation: a pack that
			// silently spends dollars is indistinguishable from a cheap one today.
			const packUsage = sumUsage([...implement, ...fixRunAll, ...verifyRunAll]);
			const usageText = packUsage ? usageLine(packUsage) : null;
			let artifactDir = null;
			let artifactError = null;
			if (args.artifact) {
				const root = path.join(args.cwd || os.tmpdir(), '.agent-pack', `${stamp()}-wolf-${safeSlug(args.objective)}`);
				try {
					await writeWolfArtifacts(root, {
						objective: args.objective, startedAt, cwd: args.cwd ?? null,
						config: {
							timeoutSec: args.timeoutSec ?? null, maxFixRounds: fixRounds,
							verifyCommand: Array.isArray(args.verifyCommand) ? args.verifyCommand : null,
							frozen: frozenPaths.length > 0 ? frozenPaths : null,
						},
						workers: [...implement, ...fixRunAll],
						verifyRounds: verifyRoundsLog,
						phaseLog,
						result: { passed, verdict, verifyRounds, lastVerifyOutput, ...(usageText ? { usage: usageText } : {}) },
					});
					artifactDir = root;
				} catch (error) {
					// never fail a finished wolf-pack over archive trouble — surface it
					artifactError = `archive write failed: ${String(error?.message ?? error)}`;
				}
			}
			return {
				objective: args.objective,
				passed: aborted ? false : passed,
				verifyRounds,
				verdict: aborted && verdict === 'PASS' ? 'PASS' : verdict,
				phaseLog,
				lastVerifyOutput: tail(lastVerifyOutput, cfg.maxOutputChars),
				...(usageText ? { usage: usageText } : {}),
				...(artifactDir ? { artifactDir } : {}),
				...(artifactError ? { artifactError } : {}),
			};
		}),
		presentCall: (args) => ({ card: 'generic', title: `Wolf-pack ×${args.wolves?.length ?? 0}`, kind: 'other', rawInput: { objective: args.objective, verify: !!args.verify } }),
	});

	registration({
		name: 'pack_resume',
		description: 'Resume or inspect past pack_wolf/pack_swarm runs via the task ledger (<cwd>/.agent-pack/ledger.json). No id: list recent tasks with status (completed/failed/interrupted). With id: re-dispatch that task VERBATIM from its saved args snapshot — this is how a half-done objective survives a dead session; call it after any interruption, or to re-run a failed/interrupted task.',
		parameters: objSchema({
			cwd: str('Workspace the task ran in (the ledger lives at <cwd>/.agent-pack/ledger.json). Defaults to the temp dir — pass the real workspace.'),
			id: str('Task id (t-...) from a previous pack_wolf/pack_swarm run. Omit to list.'),
			limit: int('List mode: how many recent entries to return (default 20).'),
		}, []),
		output: {
			schema: objSchema({
				mode: str('"list" when no id was given, "resumed" when a task was re-dispatched.'),
				cwd: str('Workspace the ledger was read from.'),
				total: int('List mode: total entries in the ledger.'),
				entries: { type: 'array', items: objSchema({
					id: str('Task id.'), kind: str('wolf | swarm.'), objective: str('What it was doing.'),
					status: str('running | completed | failed | interrupted.'),
					startedAt: str('ISO timestamp.'), finishedAt: str('ISO timestamp, null while running.'),
					verdict: str('wolf only: final verdict.'), passed: bool('wolf only: whether verify passed.'),
					succeeded: int('swarm only: bees that returned ok.'), dispatched: int('swarm only: bees dispatched.'),
					artifactDir: str('Archive dir, when written.'), error: str('Failure/interrupt detail, when any.'),
					resumedFrom: str('Id of the task this one resumes, when re-dispatched.'),
				}, ['id', 'kind', 'status']) },
				kind: str('Resumed mode: which tool was re-dispatched.'),
				id: str('Resumed mode: the NEW task id (chained via resumedFrom).'),
				result: str('Resumed mode: full JSON result of the resumed run.'),
			}, ['mode']),
			render: (_args, value) => [{
				type: 'text',
				text: value.mode === 'list'
					? `Ledger at ${value.cwd ?? '(temp)'}: ${value.total} entr${value.total === 1 ? 'y' : 'ies'}\n\n` + (value.entries ?? []).map((e) => [
						`- ${e.id} [${e.kind}] ${e.status}`,
						e.objective ? `  objective: ${e.objective}` : null,
						e.verdict != null || e.succeeded != null ? `  outcome: ${e.verdict ?? `${e.succeeded}/${e.dispatched}`}` : null,
						e.startedAt ? `  started: ${e.startedAt}` : null,
						e.error ? `  error: ${e.error}` : null,
					].filter(Boolean).join('\n')).join('\n')
					: `Resumed ${value.kind} task → new id ${value.id}\n\n${value.result ?? ''}`,
			}],
		},
		async execute(args, exec) {
			const dirRoot = path.join(args.cwd || os.tmpdir(), '.agent-pack');
			const entries = await ledgerReadSwept(dirRoot);
			const summarize = (e) => {
				const s = { id: e.id, kind: e.kind, status: e.status };
				if (e.objective) s.objective = e.objective;
				if (e.startedAt) s.startedAt = e.startedAt;
				if (e.finishedAt) s.finishedAt = e.finishedAt;
				if (e.verdict != null) s.verdict = e.verdict;
				if (e.passed != null) s.passed = e.passed;
				if (e.succeeded != null) s.succeeded = e.succeeded;
				if (e.dispatched != null) s.dispatched = e.dispatched;
				if (e.artifactDir) s.artifactDir = e.artifactDir;
				if (e.error) s.error = e.error;
				if (e.resumedFrom) s.resumedFrom = e.resumedFrom;
				return s;
			};
			if (!args.id) {
				const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
				return { mode: 'list', cwd: args.cwd ?? '(temp dir)', total: entries.length, entries: entries.slice(-limit).reverse().map(summarize) };
			}
			const prior = entries.find((e) => e.id === args.id);
			if (!prior) throw new Error(`no ledger task ${args.id} under ${dirRoot} — call pack_resume without id to list`);
			if (!prior.args || typeof prior.args !== 'object') throw new Error(`task ${args.id} has no saved args snapshot — cannot resume verbatim`);
			const impl = packImpls[prior.kind];
			if (!impl) throw new Error(`pack_${prior.kind} has not registered its implementation in this process — call pack_${prior.kind} once first, then resume`);
			const resumeArgs = { ...prior.args, __resumedFrom: prior.id };
			const result = await ledgerRun(prior.kind, resumeArgs, exec, impl);
			// The new task id lives in the ledger (ledgerRun does not return it) —
			// read it back so the caller can chain further resumes.
			let newId = null;
			try {
				const fresh = await ledgerReadSwept(dirRoot);
				newId = fresh.filter((e) => e.resumedFrom === prior.id).map((e) => e.id).pop() ?? null;
			} catch { /* ledger unavailable — id stays null */ }
			return { mode: 'resumed', kind: prior.kind, id: newId, result: JSON.stringify(result, null, 2) };
		},
		presentCall: (args) => ({ card: 'generic', title: args.id ? `Resume ${args.id}` : 'Ledger', kind: 'other', rawInput: { cwd: args.cwd ?? null, id: args.id ?? null } }),
	});

	registration({
		name: 'pack_review',
		description: "HETEROGENEOUS REVIEW (异构复审): hand the SAME artifact/design/logic to N reviewers backed by DIFFERENT agent CLIs, run them in parallel with isolated framing, then cross-compare their findings. Findings reported by more reviewers rank higher (consensus = high confidence); findings only one reviewer saw are surfaced as low confidence; every reviewer must end with `REVIEW_VERDICT: AGREE|REJECT|UNCERTAIN`. Use it before committing a design or after a wolf-pack claims done — a single model reviewing its own work is not a review.",
		parameters: objSchema({
			subject: str('What is being reviewed (the artifact, design, or claim) and where it lives — file paths, code, or the logic under audit.'),
			reviewers: {
				type: 'array',
				description: 'Reviewers; give at least 2 with different agents (that is what makes it heterogeneous).',
				items: objSchema({
					agent: str('Agent CLI from the registry.'),
					angle: str("This reviewer's angle, e.g. correctness / security / cost / API-compat / data-races."),
					model: str('Optional model override.'),
				}, ['agent', 'angle']),
			},
			question: str('The question every reviewer must answer, e.g. "does this design hold under concurrent writes?".'),
			files: {
				type: 'array',
				description: 'Exact files to read (relative to cwd or absolute). Reviewers must read ONLY these — no directory wandering, which is what makes headless reviewers time out.',
				items: str('Path to a file under review.'),
			},
			cwd: str('Working directory for the reviewers.'),
			timeoutSec: int('Per-reviewer timeout in seconds.'),
		}, ['subject', 'reviewers']),
		output: {
			schema: objSchema({
				subject: str('Subject reviewed.'),
				reviewers: int('How many reviewers ran.'),
				agents: str('Distinct agent CLIs used, comma separated.'),
				heterogeneous: bool('True when at least two distinct agent CLIs participated.'),
				agree: int('Reviewers that returned AGREE.'),
				reject: int('Reviewers that returned REJECT.'),
				uncertain: int('Reviewers that returned UNCERTAIN.'),
				missing: int('Reviewers that produced NO parsable REVIEW_VERDICT (crashed, timed out, or output truncated) — counted as not reviewed, never as agreement.'),
				consensus: str('Cross-review synthesis: verdict tallies, consensus findings, single-reviewer findings.'),
				reports: str('Every reviewer report, labeled and truncated per budget.'),
				usage: str('Token/cost spend summed over all reviewers, when their CLIs report one.'),
			}, ['subject', 'reviewers', 'agents', 'heterogeneous', 'agree', 'reject', 'uncertain', 'missing', 'consensus', 'reports']),
			render: (_args, value) => [{
				type: 'text',
				text: `Heterogeneous review of "${value.subject}" — ${value.reviewers} reviewer(s) via ${value.agents}${value.heterogeneous ? '' : ' (NOT heterogeneous: single agent family)'}\nAGREE ${value.agree} / REJECT ${value.reject} / UNCERTAIN ${value.uncertain} / NO VERDICT ${value.missing}${value.usage ? `\n${value.usage}` : ''}\n\n${value.consensus}\n\n===== reports =====\n${value.reports}`,
			}],
		},
		async execute(args, exec) {
			const reviewers = Array.isArray(args.reviewers) ? args.reviewers : [];
			if (reviewers.length < 2) throw new Error('need at least 2 reviewers — one model reviewing its own work is not a review');
			if (reviewers.length > cfg.maxWorkers) throw new Error(`at most ${cfg.maxWorkers} reviewers (got ${reviewers.length})`);
			for (const r of reviewers) {
				if (!r?.agent || !r?.angle) throw new Error('each reviewer needs agent+angle');
			}
			const agents = [...new Set(reviewers.map((r) => r.agent))];
			const subject = boundedText('复审对象描述过长，已截断', args.subject);
			const question = args.question ? `\n【必须回答的问题】\n${boundedText('问题描述过长，已截断', args.question)}` : '';
			const fileList = (Array.isArray(args.files) ? args.files : []).filter((f) => typeof f === 'string' && f.trim());
			// A long file list would push the report requirements out of the
			// tasksheet; cap it and say how many were dropped.
			const shownFiles = fileList.slice(0, 40);
			const droppedFiles = fileList.length - shownFiles.length;
			const scope = shownFiles.length > 0
				? `\n【只读这些文件】\n${shownFiles.map((f) => `- ${boundedText('路径过长', f, 300)}`).join('\n')}`
					+ (droppedFiles > 0 ? `\n（另有 ${droppedFiles} 个文件未列出，聚焦上面这些即可）` : '')
					+ '\n读完之后立刻写报告，不要再去探索别的目录或文件——无头模式下漫游会直接超时失败。'
				: '';
			const runs = await Promise.all(reviewers.map(async (r) => {
				// Each reviewer is framed in isolation: it does not see the others'
				// findings, so agreement between them is evidence, not echo.
				const task = [
					'【异构复审任务书】',
					`复审对象：${subject}`,
					`你的审查角度：${r.angle}`,
					question,
					scope,
					'',
					'工作要求：',
					'- 你有且只有这一次独立审查机会，看不到其他审查者的意见。',
					'- 必须给出具体的、可定位的问题（文件:行、字段、调用链），不要泛泛而谈。',
					'- 严格区分「确认的事实」与「你的推测」，推测要标注置信度。',
					'- 若你认可该对象，也必须说明你实际检查了什么、为什么不能推翻它。',
					'- 不要修改任何文件；你的产出就是这份审查报告。',
					'',
					'输出格式：',
					'## 结论（一句话）',
					'## 确认的问题（编号，每条带定位与影响）',
					'## 推测/待验证（带置信度）',
					'## 我实际检查了什么',
					'',
					// Written with a placeholder so a reviewer quoting this line back
					// cannot accidentally manufacture a verdict line of its own.
					'最后必须单独一行输出：REVIEW_VERDICT: <AGREE 或 REJECT 或 UNCERTAIN>（把尖括号里的词换成你的结论）',
					`工作目录：${args.cwd || os.tmpdir()}`,
				].filter(Boolean).join('\n');
				const run = await settleOne(r.agent, boundedTask('复审', task), {
					cwd: args.cwd, timeoutSec: args.timeoutSec, model: r.model, signal: exec?.signal,
					panel: { session: exec?.agent?.session, label: `复审·${r.angle} (${r.agent})` },
					schema: VERDICT_SCHEMA_REVIEW,
					schemaNote: REVIEW_SCHEMA_NOTE,
				});
				return { agent: r.agent, angle: r.angle, ...run, verdict: verdictOfRun(run, 'review') };
			}));
			const agree = runs.filter((r) => r.verdict === 'AGREE').length;
			const reject = runs.filter((r) => r.verdict === 'REJECT').length;
			// A reviewer that crashed or produced no verdict is NOT "uncertain";
			// folding the two together turns a broken reviewer into an opinion.
			const uncertain = runs.filter((r) => r.verdict === 'UNCERTAIN').length;
			const missing = runs.length - agree - reject - uncertain;
			const perReviewerChars = Math.max(3000, Math.floor(cfg.maxOutputChars / Math.max(1, runs.length)));
			const consensus = [
				`verdict tally: AGREE ${agree} / REJECT ${reject} / UNCERTAIN ${uncertain} / NO VERDICT ${missing}`,
				...(missing > 0
					? [`⚠ ${missing} 名审查者没有给出 REVIEW_VERDICT（崩溃、超时或被截断）——这部分覆盖面按「未审查」计，不要当成认可。`]
					: []),
				...(reject > 0
					? ['⚠ 有审查者否决——在否决理由被逐条回应前，不要把它当作已通过。']
					: agree === runs.length
						? ['全部审查者一致认可。']
						: ['无否决，但意见不一致——逐条读下面的报告再决定。']),
				'跨审查者比对方法：把各报告「确认的问题」并排读——多名审查者指向同一处的是高置信缺陷；只有一人提出的先当低置信线索，自己去代码里核。',
			].join('\n');
			const reports = runs.map((r) => [
				`===== [verifier ${r.agent}] ${r.verdict} — angle: ${r.angle} ${r.ok ? '' : `(exit ${r.exitCode}${r.spawnError ? `, ${r.spawnError}` : ''})`} =====`,
				tail(r.output ?? '', perReviewerChars),
			].join('\n')).join('\n\n');
			const reviewUsage = sumUsage(runs);
			return {
				subject: args.subject,
				reviewers: runs.length,
				agents: agents.join(', '),
				heterogeneous: agents.length >= 2,
				agree,
				reject,
				uncertain,
				missing,
				consensus,
				reports,
				...(reviewUsage ? { usage: usageLine(reviewUsage) } : {}),
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Heterogeneous review ×${args.reviewers?.length ?? 0}`, kind: 'other', rawInput: { subject: args.subject } }),
	});

	registration({
		name: 'pack_plan',
		description: 'Suggest a swarm or wolf-pack composition for an objective, using registry health + capability scores. Returns an editable bees/wolves array to pass straight into pack_swarm / pack_wolf.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				objective: str('What you want to achieve.'),
				research: bool('Force swarm mode (default: auto-detect from keywords).'),
			},
			required: ['objective'],
		},
		output: {
			schema: objSchema({
				mode: str('Suggested mode: swarm or wolf.'),
				suggestion: str('JSON text of an editable bees/wolves spec for pack_swarm/pack_wolf.'),
				rationale: str('Why this composition.'),
			}, ['mode', 'suggestion', 'rationale']),
			render: (_args, value) => [{ type: 'text', text: `Suggested mode: ${value.mode}\n${value.rationale}\n\n${value.suggestion}` }],
		},
		async execute(args) {
			if (!args.objective || !String(args.objective).trim()) {
				throw new Error('objective is required — pass a non-empty description of what you want to achieve (missing args usually mean the model gateway dropped the tool-call arguments)');
			}
			const registry = await readRegistry();
			const available = Object.values(registry.agents ?? {}).filter(dispatchable);
			if (available.length === 0) throw new Error('no healthy dispatchable agent — run pack_registry_scan first');
			const score = (a, dim) => effectiveScore(a, dim).value;
			// Where each rank came from: 'measured' is evidence from real eval runs,
			// 'prior' is the hand-written opinion in KNOWN_AGENTS. The caller deserves
			// to know which one is steering the composition.
			const why = (a, dim) => `${a.name}(${score(a, dim)} ${effectiveScore(a, dim).source})`;
			const researchy = args.research === true || /调研|研究|分析|比较|评测|评估|综述|竞品|选型|research|analy|compar|survey|investigat/i.test(args.objective);
			const mode = researchy ? 'swarm' : 'wolf';
			const byResearch = [...available].sort((x, y2) => score(y2, 'research') - score(x, 'research'));
			const byCoding = [...available].sort((x, y2) => score(y2, 'coding') - score(x, 'coding'));
			let suggestion;
			let rationale;
			if (researchy) {
				const angles = ['market/landscape scan', 'technical mechanism deep-dive', 'risks & cost review'];
				suggestion = JSON.stringify({
					objective: args.objective,
					bees: angles.map((angle, i) => ({
						label: `bee-${i + 1}-${angle.split(/[ /]/)[0]}`,
						agent: byResearch[i % byResearch.length].name,
						prompt: `围绕「${args.objective}」负责角度：${angle}。给出结构化发现+来源。`,
					})),
				}, null, 2);
				rationale = `research agents ranked: ${byResearch.map((a) => why(a, 'research')).join(', ')}`;
			} else {
				// Keep one healthy family in reserve as an independent verifier:
				// cycling all families through wolf roles (i % byCoding.length) left
				// no heterogeneous agent to judge the pack with.
				const roles = ['db', 'api', 'frontend', 'test'].slice(0, Math.max(1, byCoding.length - 1));
				const wolves = roles.map((role, i) => ({
					role,
					agent: byCoding[i % byCoding.length].name,
					prompt: `角色 ${role}：完成「${args.objective}」中属于 ${role} 的部分，保持与其他角色文件范围不相交。`,
				}));
				// Prefer a verifier from a DIFFERENT agent family than the wolves it
				// judges (heterogeneous acceptance), falling back to the top scorer
				// when only one healthy agent exists. Never embed the literal verdict
				// words here: the tasksheet appends the placeholder protocol line, and
				// a literal "WOLF_VERDICT: PASS" in this prompt could be echoed back
				// by the verifier and forge a verdict.
				const wolfAgents = new Set(wolves.map((w) => w.agent));
				// Among the non-wolf families, prefer the best evidence: a family with a
				// measured 0/1 should not judge the pack while a better one is free.
				const verifyPool = byCoding
					.filter((a) => !wolfAgents.has(a.name))
					.sort((x, y2) => score(y2, 'coding') - score(x, 'coding'));
				const verifyPick = verifyPool[0] ?? byCoding[0];
				const verifyAgent = verifyPick.name;
				suggestion = JSON.stringify({
					objective: args.objective,
					wolves,
					verify: { agent: verifyAgent, prompt: `运行构建/测试，逐项核对「${args.objective}」的完成度，把每条命令与其真实输出贴进报告；结论写在末行协议里（按任务书要求的占位符格式换成你的结论）。`, timeoutSec: cfg.defaultTimeoutSec },
					maxFixRounds: 2,
				}, null, 2);
				rationale = `coding agents ranked: ${byCoding.map((a) => why(a, 'coding')).join(', ')}; roles capped to ${roles.length} so one family stays free as an independent verifier; verifier × ${why(verifyPick, 'coding')}`;
				// A verifier whose own measured evidence is a failure is a trap: the pack
				// would be judged by the one CLI that cannot complete a case. Say it out
				// loud instead of quietly producing NO VERDICT rounds.
				if (score(verifyPick, 'coding') <= 0) {
					rationale += ` ⚠ ${verifyPick.name} has failed every measured case — it is still the only heterogeneous family available, but expect NO VERDICT: pass your own verifier or re-run pack_eval first`;
				}
			}
			return { mode, suggestion, rationale };
		},
		presentCall: (args) => ({ card: 'generic', title: 'Plan pack composition', kind: 'other', rawInput: { objective: args.objective } }),
	});

	// ---------- evaluation suite (AI-native SDLC, playbook pattern ④) ----------
	// A regression suite of REAL tasks over the agent registry: run it after a
	// scan, a template edit, or any config change, and every breakage shows up
	// as a red case instead of a surprise mid-wolf-pack. Expectations are checked
	// deterministically (substring/regex/file) — no LLM judging the judge.
	const evalCaseItem = objSchema({
		id: str('Unique case id.'),
		agent: str("Agent CLI name, or '*' to expand to every healthy dispatchable agent in the registry."),
		prompt: str('Task prompt sent to the agent.'),
		cwd: str('Working directory override for this case.'),
		timeoutSec: int('Per-case timeout override (seconds).'),
		model: str('Optional model override.'),
		tags: { type: 'array', items: str('Tag.'), description: 'Optional tags; when the tags filter is set, only cases with a matching tag run.' },
		expect: objSchema({
			exitOk: bool('Require exit code 0 (default true). Set false to accept any exit code.'),
			contains: str('Substring the output must include.'),
			matches: str('Regex the output must match (case-insensitive unless matchesFlags says otherwise).'),
			matchesFlags: str('RegExp flags for matches (default "i").'),
			file: str('File that must exist after the run (path relative to cwd).'),
			fileContains: str('Substring the file content must include (used together with file).'),
		}, []),
	}, ['id', 'agent', 'prompt']);

	const EVAL_CASE_CAP = 50;

	function checkExpect(expect, run, cwd) {
		const problems = [];
		const exp = expect && typeof expect === 'object' ? expect : {};
		// A spawn failure or a timeout is never a pass, even when the caller
		// accepts a nonzero exit: the case did not actually run to completion.
		if (run.spawnError) problems.push(`spawn failed: ${run.spawnError}`);
		if (run.timedOut) problems.push(`timed out after ${Math.round((run.durationMs ?? 0) / 1000)}s`);
		if ((exp.exitOk ?? true) && !run.spawnError && !run.timedOut && run.exitCode !== 0) {
			problems.push(`expected exit 0, got ${run.exitCode ?? '-'}`);
		}
		if (exp.contains != null && !String(run.output ?? '').includes(String(exp.contains))) {
			problems.push(`output does not contain ${JSON.stringify(String(exp.contains).slice(0, 120))}`);
		}
		if (exp.matches != null) {
			let re = null;
			try {
				re = new RegExp(String(exp.matches), typeof exp.matchesFlags === 'string' ? exp.matchesFlags : 'i');
			} catch (error) {
				problems.push(`invalid matches regex: ${String(error?.message ?? error)}`);
			}
			if (re && !re.test(String(run.output ?? ''))) {
				problems.push(`output does not match /${String(exp.matches).slice(0, 120)}/`);
			}
		}
		if (exp.file != null && String(exp.file).trim()) {
			const abs = path.resolve(cwd || os.tmpdir(), String(exp.file));
			if (!isFile(abs)) problems.push(`expected file missing: ${exp.file}`);
			else if (exp.fileContains != null) {
				let text = '';
				try { text = fs.readFileSync(abs, 'utf8'); } catch (error) {
					problems.push(`file unreadable: ${String(error?.message ?? error)}`);
				}
				if (text && !text.includes(String(exp.fileContains))) {
					problems.push(`file ${exp.file} does not contain ${JSON.stringify(String(exp.fileContains).slice(0, 120))}`);
				}
			}
		}
		return problems;
	}

	// Bounded concurrency: a suite can hold dozens of cases and Promise.all over
	// them would fork-bomb the machine. Lanes = maxWorkers, like every other tool.
	async function runPool(items, worker) {
		const results = new Array(items.length);
		let next = 0;
		const lanes = Array.from({ length: Math.max(1, Math.min(cfg.maxWorkers, items.length)) }, async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await worker(items[i], i);
			}
		});
		await Promise.all(lanes);
		return results;
	}

	registration({
		name: 'pack_eval',
		description: 'Run an evaluation suite of real tasks against the agent registry and check each output with deterministic expectations (contains/matches/file). Use it to regression-test agent config: after a registry scan, a template edit, or any change to config.templates — a broken template or degraded CLI shows up as a red case here instead of a surprise mid-wolf-pack. No cases given = built-in smoke baseline (one AGENT-OK probe per healthy agent). Expectations are checked deterministically; no LLM judging the judge. Results are recorded into the registry as raw per-case samples (rolling window of the last 12 per agent) and pack_plan then routes on that evidence instead of the hand-written prior; tag cases "coding" or "research" to measure those dimensions separately — an untagged run never erases a tagged measurement.',
		parameters: objSchema({
			cases: { type: 'array', items: evalCaseItem, description: 'Eval cases (inline suite). Omit together with suitePath for the built-in smoke baseline. Pass either cases or suitePath, not both.' },
			suitePath: str('Path to a suite JSON file: {"cases":[...same shape as the cases items...]}.'),
			tags: { type: 'array', items: str('Tag.'), description: 'When set, only cases carrying at least one of these tags run.' },
			cwd: str('Default working directory for cases without their own cwd.'),
			timeoutSec: int('Default per-case timeout in seconds.'),
			record: bool('Feed the results back into the registry as measured capability (default true). Set false to measure without touching routing data.'),
			artifact: bool('Write the run archive (manifest.json + cases/) under <cwd>/.agent-pack/<timestamp>-eval-<slug>/ and return its path.'),
		}, []),
		output: {
			schema: objSchema({
				suite: str('Which suite ran: builtin-smoke / inline / the suitePath.'),
				build: str('Which build of this plugin is loaded (proves the running code is current).'),
				total: int('Number of cases run after expansion.'),
				passed: int('Cases whose expectations all held.'),
				failed: int('Cases with at least one failed expectation.'),
				cases: {
					type: 'array',
					items: objSchema({
						id: str('Case id.'),
						agent: str('Agent the case ran on.'),
						pass: bool('Whether all expectations held.'),
						durationMs: int('Wall-clock duration.'),
						problems: { type: 'array', items: str('One failed expectation.'), description: 'Empty when the case passed.' },
					}, ['id', 'agent', 'pass', 'durationMs', 'problems']),
				},
				artifactDir: str('Directory holding the run archive. Present only when artifact=true.'),
				artifactError: str('Archive write failure detail, when artifact=true but the archive could not be written.'),
				measured: str('What this run recorded into the registry as measured capability (empty when record=false or nothing was measurable).'),
			}, ['suite', 'build', 'total', 'passed', 'failed', 'cases']),
			render: (_args, value) => [{
				type: 'text',
				text: `Eval suite "${value.suite}": ${value.passed}/${value.total} passed, ${value.failed} failed. [build ${value.build}]\n`
					+ value.cases.map((c) => `- [${c.id}] ${c.agent} ${c.pass ? 'PASS' : `FAIL (${c.problems.join('; ')})`} in ${Math.round(c.durationMs / 1000)}s`).join('\n')
					+ (value.measured ? `\nRecorded measurements:\n${value.measured}` : '')
					+ (value.artifactDir ? `\nArtifacts: ${value.artifactDir}` : '')
					+ (value.artifactError ? `\nArtifact error: ${value.artifactError}` : ''),
			}],
		},
		async execute(args, exec) {
			if (args.cases != null && args.suitePath != null) {
				throw new Error('pass either cases or suitePath, not both');
			}
			let rawCases;
			let suiteLabel;
			if (Array.isArray(args.cases)) {
				rawCases = args.cases;
				suiteLabel = 'inline';
			} else if (args.suitePath != null && String(args.suitePath).trim()) {
				const suiteFile = path.resolve(String(args.suitePath));
				let parsed;
				try {
					parsed = JSON.parse(await readFile(suiteFile, 'utf8'));
				} catch (error) {
					throw new Error(`cannot read suite ${suiteFile}: ${String(error?.message ?? error)}`);
				}
				if (!parsed || !Array.isArray(parsed.cases)) {
					throw new Error(`suite ${suiteFile} must be JSON of shape {"cases":[...]}`);
				}
				rawCases = parsed.cases;
				suiteLabel = suiteFile;
			} else {
				// Built-in smoke baseline: one cheap probe per healthy agent. This is
				// the "run after every config change" default — if a template or shim
				// broke, the agent that used to answer now fails here.
				rawCases = [{
					id: 'smoke', agent: '*',
					prompt: 'Reply with exactly this single word on one line and nothing else: AGENT-OK',
					expect: { contains: 'AGENT-OK' },
					tags: ['smoke'],
				}];
				suiteLabel = 'builtin-smoke';
			}
			if (!Array.isArray(rawCases) || rawCases.length === 0) {
				throw new Error('cases[] must contain at least one entry');
			}
			for (const c of rawCases) {
				if (!c?.id || typeof c.id !== 'string') throw new Error('each case needs a string id');
				if (!c?.agent || typeof c.agent !== 'string') throw new Error(`case "${c.id}" needs an agent (or "*")`);
				if (!c?.prompt || typeof c.prompt !== 'string') throw new Error(`case "${c.id}" needs a prompt`);
				if (c.prompt.length > cfg.maxPromptChars) throw new Error(`case "${c.id}" prompt exceeds ${cfg.maxPromptChars} chars`);
			}
			// Expand '*' to every healthy dispatchable agent (same filter pack_plan
			// ranks by). Poisoned/absent templates fail their case via loadProfile in
			// settleOne — which is the suite doing its job, not an error.
			const registry = await readRegistry();
			const healthy = Object.values(registry.agents ?? {})
				.filter(dispatchable)
				.map((a) => a.name);
			const expanded = [];
			for (const c of rawCases) {
				if (c.agent === '*') {
					if (healthy.length === 0) throw new Error(`case "${c.id}" uses "*" but no healthy dispatchable agent exists — run pack_registry_scan first`);
					for (const name of healthy) expanded.push({ ...c, id: `${c.id}-${name}`, agent: name });
				} else {
					expanded.push(c);
				}
			}
			const wanted = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim()) : null;
			const selected = wanted
				? expanded.filter((c) => Array.isArray(c.tags) && c.tags.some((t) => wanted.includes(t)))
				: expanded;
			if (selected.length === 0) {
				throw new Error(`no case matches tags [${wanted.join(', ')}] — cases need explicit tags to be filterable`);
			}
			if (selected.length > EVAL_CASE_CAP) {
				throw new Error(`at most ${EVAL_CASE_CAP} cases per run (got ${selected.length}) — split the suite or narrow the tags`);
			}
			const startedAt = new Date().toISOString();
			const ran = await runPool(selected, async (c) => {
				const run = await settleOne(c.agent, c.prompt, {
					cwd: c.cwd ?? args.cwd, timeoutSec: c.timeoutSec ?? args.timeoutSec,
					model: c.model, signal: exec?.signal,
				});
				const problems = checkExpect(c.expect, run, c.cwd ?? args.cwd);
				return {
					id: c.id, agent: c.agent, prompt: c.prompt,
					pass: problems.length === 0, problems,
					ok: run.ok, exitCode: run.exitCode, timedOut: run.timedOut,
					spawnError: run.spawnError ?? null, durationMs: run.durationMs,
					output: run.output ?? '',
				};
			});
			const passed = ran.filter((r) => r.pass).length;
			// Feedback loop: measurements are the only evidence we have about how a
			// CLI actually behaves, so they go back into the registry and pack_plan
			// prefers them over the hand-written prior. Raw samples only (one record
			// per case) — no synthesized score ever lands in the file, and a run that
			// covers one dimension never erases samples from another.
			let measuredText = '';
			if (args.record !== false) {
				try {
					const byAgent = samplesByAgent(ran.map((r) => ({ ...r, tags: selected.find((s) => s.id === r.id)?.tags ?? [] })));
					if (byAgent.size > 0) {
						const fresh = await readRegistry();
						const at = new Date().toISOString();
						const lines = [];
						for (const [name, freshSamples] of byAgent) {
							const agent = fresh.agents?.[name];
							if (!agent) continue; // pseudo/unknown agents have no profile to score
							agent.measured = { at, samples: mergeSamples(agent.measured, freshSamples) };
							lines.push(`- ${name}: ${measuredLine({ measured: agent.measured })}`);
						}
						if (lines.length > 0) {
							await writeRegistry(fresh);
							measuredText = lines.join('\n');
						}
					}
				} catch (error) {
					// A measurement write must never fail the suite that produced it.
					measuredText = `(measurement write failed: ${String(error?.message ?? error)})`;
				}
			}
			let artifactDir = null;
			let artifactError = null;
			if (args.artifact) {
				const root = path.join(args.cwd || os.tmpdir(), '.agent-pack', `${stamp()}-eval-${safeSlug(suiteLabel)}`);
				try {
					await writeEvalArtifacts(root, {
						startedAt, cwd: args.cwd ?? null, suite: suiteLabel,
						result: { total: ran.length, passed, failed: ran.length - passed },
						cases: ran,
					});
					artifactDir = root;
				} catch (error) {
					// never fail a finished eval over archive trouble — surface it
					artifactError = `archive write failed: ${String(error?.message ?? error)}`;
				}
			}
			return {
				suite: suiteLabel,
				build: BUILD,
				total: ran.length,
				passed,
				failed: ran.length - passed,
				cases: ran.map((r) => ({
					id: r.id, agent: r.agent, pass: r.pass, durationMs: r.durationMs,
					problems: r.problems,
				})),
				...(measuredText ? { measured: measuredText } : {}),
				...(artifactDir ? { artifactDir } : {}),
				...(artifactError ? { artifactError } : {}),
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Eval suite ×${Array.isArray(args.cases) ? args.cases.length : (args.suitePath ? 'file' : 'smoke')}`, kind: 'other', rawInput: { suitePath: args.suitePath ?? null, tags: args.tags ?? null } }),
	});
}

export { apply, inject, name };
