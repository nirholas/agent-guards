import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createGuards, guards, policy, guard,
	ThreeWsError, PaymentRequiredError,
	TRADE_LIMIT_DEFAULTS, LAMPORTS_PER_SOL,
} from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A synthetic base58 mint — never a real third-party coin. The only coin is $THREE.
const MINT = 'THREEsynthetic1111111111111111111111111111';
const DEST = 'THREEsynthdest11111111111111111111111111111';

// ── local policy builder ──────────────────────────────────────────────────────

test('policy() normalizes + bounds fields like the server', () => {
	const p = policy({
		per_trade_sol: '0.5',
		daily_budget_sol: 2,
		max_price_impact_pct: 250, // clamps to 100
		max_slippage_bps: 99999,   // clamps to 10000, rounds
		max_concurrent: 0,         // below min 1 → null
		kill_switch: 'yes',        // not === true → false
		per_tx_usd: -5,            // negative → null
		daily_usd: 100,
		withdraw_allowlist: [DEST, DEST, 'not-base58!'],
		frozen: true,
	});
	assert.equal(p.per_trade_sol, 0.5);
	assert.equal(p.daily_budget_sol, 2);
	assert.equal(p.max_price_impact_pct, 100);
	assert.equal(p.max_slippage_bps, 10000);
	assert.equal(p.max_concurrent, null);
	assert.equal(p.kill_switch, false);
	assert.equal(p.per_tx_usd, null);
	assert.equal(p.daily_usd, 100);
	assert.deepEqual(p.withdraw_allowlist, [DEST]); // de-duped, invalid dropped
	assert.equal(p.frozen, true);
});

test('an empty policy falls back to the server defaults (uncapped)', () => {
	const p = policy({});
	assert.equal(p.per_trade_sol, TRADE_LIMIT_DEFAULTS.per_trade_sol);
	assert.equal(p.max_price_impact_pct, TRADE_LIMIT_DEFAULTS.max_price_impact_pct);
	assert.equal(p.max_slippage_bps, TRADE_LIMIT_DEFAULTS.max_slippage_bps);
	assert.equal(p.kill_switch, false);
});

// ── local guard decisions ──────────────────────────────────────────────────────

test('guard() allows a buy that clears every check', () => {
	const p = policy({ per_trade_sol: 1, daily_budget_sol: 5, max_price_impact_pct: 15 });
	const d = guard({ side: 'buy', amountSol: 0.3, priceImpactPct: 4, spentLamports: 0n, walletLamports: 2n * LAMPORTS_PER_SOL }, p);
	assert.equal(d.allow, true);
	assert.equal(d.reason, null);
	assert.equal(d.message, null);
});

test('per-trade SOL cap blocks an oversized buy', () => {
	const p = policy({ per_trade_sol: 0.5 });
	const d = guard({ side: 'buy', amountSol: 0.8, priceImpactPct: 1 }, p);
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'per_trade_cap');
	// detail carries the lamports numbers behind the decision.
	assert.equal(d.detail.amount_lamports, '800000000');
	assert.equal(d.detail.cap_lamports, '500000000');
	assert.match(d.message, /per-trade cap/);
});

test('rolling daily SOL budget blocks when spent + amount exceeds budget', () => {
	const p = policy({ daily_budget_sol: 2 });
	// 1.8 already spent + 0.5 this buy = 2.3 > 2.0
	const spent = (18n * LAMPORTS_PER_SOL) / 10n;
	const d = guard({ side: 'buy', amountSol: 0.5, spentLamports: spent }, p);
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'daily_budget');
	assert.equal(d.detail.budget_lamports, '2000000000');
	assert.equal(d.detail.spent_lamports, '1800000000');
});

test('a buy at exactly the daily budget edge is allowed', () => {
	const p = policy({ daily_budget_sol: 2 });
	const spent = (15n * LAMPORTS_PER_SOL) / 10n; // 1.5 spent + 0.5 = 2.0, == budget
	const d = guard({ side: 'buy', amountSol: 0.5, spentLamports: spent }, p);
	assert.equal(d.allow, true);
});

test('price-impact breaker blocks a bad-price trade independent of size', () => {
	const p = policy({ max_price_impact_pct: 10 });
	const d = guard({ side: 'buy', amountSol: 0.01, priceImpactPct: 12 }, p);
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'price_impact');
	assert.equal(d.detail.impact_pct, 12);
	assert.equal(d.detail.max_pct, 10);
});

test('kill switch rejects every discretionary buy', () => {
	const d = guard({ side: 'buy', amountSol: 0.001 }, policy({ kill_switch: true }));
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'kill_switch');
});

test('concurrency ceiling blocks when open positions are at the max', () => {
	const p = policy({ max_concurrent: 3 });
	const d = guard({ side: 'buy', amountSol: 0.1, openCount: 3 }, p);
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'max_positions');
	assert.equal(d.detail.open, 3);
	assert.equal(d.detail.max, 3);
});

test('SOL headroom floor blocks a buy the wallet cannot cover with fees', () => {
	const p = policy({});
	// wallet holds 0.3 SOL, buy is 0.3 SOL, but ~0.003 headroom is required on top.
	const d = guard({ side: 'buy', amountSol: 0.3, walletLamports: 300_000_000n }, p);
	assert.equal(d.allow, false);
	assert.equal(d.reason, 'insufficient_sol');
});

test('per-tx + daily USD ceilings block a priced buy', () => {
	const perTx = guard({ side: 'buy', amountSol: 1, usdValue: 30 }, policy({ per_tx_usd: 25 }));
	assert.equal(perTx.reason, 'per_tx_exceeded');
	assert.equal(perTx.detail.usd, 30);

	const daily = guard({ side: 'buy', amountSol: 1, usdValue: 30, spentUsd: 80 }, policy({ daily_usd: 100 }));
	assert.equal(daily.reason, 'daily_exceeded');
	assert.match(daily.message, /daily limit/);
});

test('a sell skips the spend caps but still honors the kill switch + breaker', () => {
	// Way over the per-trade cap, but sells move SOL inward → caps do not apply.
	const ok = guard({ side: 'sell', amountSol: 999, priceImpactPct: 1 }, policy({ per_trade_sol: 0.1 }));
	assert.equal(ok.allow, true);

	const killed = guard({ side: 'sell', amount: 'max' }, policy({ kill_switch: true }));
	assert.equal(killed.reason, 'kill_switch');

	const impact = guard({ side: 'sell', priceImpactPct: 50 }, policy({ max_price_impact_pct: 10 }));
	assert.equal(impact.reason, 'price_impact');
});

test('frozen wallet blocks autonomous paths but leaves owner withdraw open', () => {
	const p = policy({ frozen: true });
	assert.equal(guard({ side: 'buy', amountSol: 0.1, category: 'trade' }, p).reason, 'wallet_frozen');
	assert.equal(guard({ side: 'buy', amountSol: 0.1, category: 'snipe' }, p).reason, 'wallet_frozen');
	// Withdraw is the owner recovery path — a freeze must never trap the funds.
	assert.equal(guard({ category: 'withdraw', destination: DEST }, p).allow, true);
});

test('withdraw allowlist gates the destination', () => {
	const p = policy({ withdraw_allowlist: [DEST] });
	assert.equal(guard({ category: 'withdraw', destination: DEST }, p).allow, true);
	const blocked = guard({ category: 'withdraw', destination: 'THREEother1111111111111111111111111111111' }, p);
	assert.equal(blocked.allow, false);
	assert.equal(blocked.reason, 'destination_not_allowed');
});

test('guard() accepts a loose policy patch directly (auto-normalizes)', () => {
	const d = guard({ side: 'buy', amountSol: 0.8 }, { per_trade_sol: 0.5 });
	assert.equal(d.reason, 'per_trade_cap');
});

test('guard() throws invalid_input for a buy with no amount', () => {
	assert.throws(() => guard({ side: 'buy' }, policy({})), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
});

// ── HTTP client ────────────────────────────────────────────────────────────────

test('getTradeLimits() reads /trade/limits and shapes camelCase + defaults', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { limits: { per_trade_sol: 0.5, daily_budget_sol: 2, max_price_impact_pct: 10, max_slippage_bps: 500, max_concurrent: 3, kill_switch: false }, defaults: TRADE_LIMIT_DEFAULTS } } },
	]);
	const a = createGuards({ fetch, baseUrl: 'https://three.ws' }).forAgent('agent_abc');
	const lim = await a.getTradeLimits();

	assert.equal(calls[0].url.pathname, '/api/agents/agent_abc/trade/limits');
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(lim.perTradeSol, 0.5);
	assert.equal(lim.dailyBudgetSol, 2);
	assert.equal(lim.maxConcurrent, 3);
	assert.equal(lim.killSwitch, false);
	assert.ok(lim.defaults);
});

test('setTradeLimits() PUTs only recognized keys', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { limits: { per_trade_sol: 0.5, kill_switch: true } } } },
	]);
	const a = guards('agent_abc', { fetch, token: 'owner_token' });
	const lim = await a.setTradeLimits({ per_trade_sol: 0.5, kill_switch: true, bogus_key: 1 });

	assert.equal(calls[0].init.method, 'PUT');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.per_trade_sol, 0.5);
	assert.equal(sent.kill_switch, true);
	assert.ok(!('bogus_key' in sent), 'unrecognized keys are stripped so a typo never widens the leash');
	assert.equal(calls[0].init.headers.authorization, 'Bearer owner_token');
	assert.equal(lim.killSwitch, true);
});

test('checkTrade() previews via /trade/quote and surfaces the blocked reason', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { allowed: false, side: 'buy', mint: MINT, venue: 'bonding_curve', price_impact_pct: 4, blocked_reason: { code: 'per_trade_cap', message: 'over the per-trade cap', detail: { amount_lamports: '300000000', cap_lamports: '250000000' } } } } },
	]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	const d = await a.checkTrade({ side: 'buy', mint: MINT, amount: 0.3 });

	assert.equal(calls[0].url.pathname, '/api/agents/agent_abc/trade/quote');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.side, 'buy');
	assert.equal(sent.mint, MINT);
	assert.equal(sent.amount, 0.3);
	assert.equal(d.allowed, false);
	assert.equal(d.reason, 'per_trade_cap');
	assert.equal(d.detail.cap_lamports, '250000000');
});

test('trade() executes against /trade with simulate flagged off by default', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { signature: 'sig123', side: 'buy', mint: MINT, network: 'mainnet', venue: 'bonding_curve' } } },
	]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	const r = await a.trade({ side: 'buy', mint: MINT, amount: 0.3, idempotencyKey: 'k1' });

	assert.equal(calls[0].url.pathname, '/api/agents/agent_abc/trade');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.simulate, false);
	assert.equal(sent.idempotency_key, 'k1');
	assert.equal(r.signature, 'sig123');
});

test('getSpendLimits() reads /wallet/limits and passes the network query', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { limits: { daily_usd: 100, per_tx_usd: 25, withdraw_allowlist: [DEST], frozen: false }, spent_today_usd: 12.5, spent_today_sol: 0.4 } } },
	]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	const lim = await a.getSpendLimits({ network: 'devnet' });

	assert.equal(calls[0].url.pathname, '/api/agents/agent_abc/wallet/limits');
	assert.equal(calls[0].url.searchParams.get('network'), 'devnet');
	assert.equal(lim.dailyUsd, 100);
	assert.deepEqual(lim.withdrawAllowlist, [DEST]);
	assert.equal(lim.spentTodayUsd, 12.5);
});

test('setSpendLimits() PUTs the freeze switch onto /wallet/limits', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { limits: { daily_usd: null, per_tx_usd: null, withdraw_allowlist: [], frozen: true } } } },
	]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	const lim = await a.setSpendLimits({ frozen: true });

	assert.equal(calls[0].init.method, 'PUT');
	assert.equal(JSON.parse(calls[0].init.body).frozen, true);
	assert.equal(lim.frozen, true);
});

test('invalid trade input is rejected before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	await assert.rejects(() => a.checkTrade({ side: 'hodl', mint: MINT, amount: 1 }), /Invalid side/);
	await assert.rejects(() => a.checkTrade({ side: 'buy', mint: 'nope!', amount: 1 }), /base58 Solana `mint`/);
	await assert.rejects(() => a.checkTrade({ side: 'buy', mint: MINT, amount: -1 }), /positive number/);
	assert.equal(calls.length, 0);
});

test('an empty agent id is rejected before any network call', () => {
	const c = createGuards({ fetch: () => {} });
	assert.throws(() => c.forAgent('   '), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
});

test('a server guard rejection surfaces as a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 422, body: { error: 'per_trade_cap', message: 'over the cap', detail: { cap_lamports: '250000000' } } }]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	await assert.rejects(() => a.trade({ side: 'buy', mint: MINT, amount: 0.3 }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'per_trade_cap');
		assert.equal(e.status, 422);
		assert.equal(e.detail.cap_lamports, '250000000');
		return true;
	});
});

test('402 surfaces as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '150000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const a = createGuards({ fetch }).forAgent('agent_abc');
	await assert.rejects(() => a.trade({ side: 'buy', mint: MINT, amount: 0.3 }), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});
