// Agent bench: fixed coding tasks through the REAL engine and router (Auto routing as a fresh
// install sees it, real providers) on a throwaway copy of a small Node project, each graded by
// checks the model never sees. Measures what the user waits for — wall time to a checked result —
// and where it went: model steps, first-chunk waits, child processes (ripgrep searches, model
// commands, the verify gate), requests, tokens, questions asked. Details go to .benchmarks/ for before/after comparison.
//
// Run: npm run bench:agent
//   TASKS=fix-add,rename          only these tasks
//   REPEAT=3                      runs per task (default 1)
//   MODEL=opencode::big-pickle    pin one model (default: Auto)
//   TIERMUX_KEY_<PLATFORM>=...    a key for a keyed platform (e.g. TIERMUX_KEY_GROQ)
//   BASELINE=.benchmarks/agent-bench-<stamp>.json   print the change against an earlier run
//   TASK_TIMEOUT_MS=600000        abort a run after this long (default 10 min)
//   KEEP=1                        leave each task workspace on disk (prints its path)
//   GRADER_CHECK=1                a model that does nothing: every task must FAIL, or its check is broken
//   BENCH_DIR=~/.cache/tiermux-bench   where task workspaces live (under $HOME: container php wrappers
//                                 such as lerd refuse or crawl in /tmp; outside the repo so model git
//                                 commands never touch it)

import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { runAgentStream, runPlanStream } from '../src/agent/agent';
import { capForHistory } from '../src/agent/condense';
import { formatPlanForCard } from '../src/agent/planStructurer';
import { planStepsToTodos } from '../src/session/titles';
import { __setEngineModelForTests } from '../src/agent/core/engine';
import { createMockModel } from './mockModel';
import type { AgentOpts, AgentResult } from '../src/agent/agent';
import { runWithWorkspaceRoot } from '../src/agent/core/tools/workspaceRoot';
import { invalidatePromptContext } from '../src/context/promptContext';
import { Catalog } from '../src/catalog/catalog';
import { SettingsStore } from '../src/config/settingsStore';
import { SecretStore } from '../src/config/secrets';
import { setModelSources } from '../src/router/picker';
import { allPlatformInfo } from '../src/providers';
import type { Platform, ProposedPlan } from '../src/shared/types';

const WORKER = 'https://tiermux.mainulislam3057.workers.dev/';
const ROOT = join(__dirname, '..');

/* ---------- the fixture project (green as seeded; each task breaks or asks for something) ---------- */

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'bench-app', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# bench-app\n\nA small billing library.\n',
  'src/math.js': 'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n',
  'src/math.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add, mul } = require('./math');\n\ntest('add', () => {\n  assert.strictEqual(add(2, 3), 5);\n  assert.strictEqual(add(-1, -1), -2);\n});\n\ntest('mul', () => {\n  assert.strictEqual(mul(3, 4), 12);\n});\n",
  'src/billing/invoice.js': "function parseInvoice(raw) {\n  const [id, total] = raw.split(',');\n  return { id: id.trim(), total: Number(total) };\n}\n\nmodule.exports = { parseInvoice };\n",
  'src/billing/invoice.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { parseInvoice } = require('./invoice');\n\ntest('parseInvoice trims the id', () => {\n  assert.deepStrictEqual(parseInvoice(' A1 ,12.5'), { id: 'A1', total: 12.5 });\n});\n",
  'src/report.js': "const { mul } = require('./math');\nconst { parseInvoice } = require('./billing/invoice');\n\nfunction lineTotal(qty, price) {\n  return mul(qty, price);\n}\n\nfunction totals(lines) {\n  return lines.map(parseInvoice).map((inv) => inv.total);\n}\n\nmodule.exports = { lineTotal, totals };\n",
  'src/index.js': "module.exports = {\n  ...require('./math'),\n  ...require('./billing/invoice'),\n  ...require('./report'),\n};\n",
};

/** A Composer project with an installed vendor/ but no test suite: the engine's verify gate finds
 *  nothing to run here, so a broken file is caught only by the per-edit checks. */
const BASE_PHP: Record<string, string> = {
  'composer.json': JSON.stringify({ name: 'bench/shop', autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2) + '\n',
  'vendor/autoload.php': "<?php\nspl_autoload_register(function (string $class): void {\n    $file = __DIR__ . '/../src/' . str_replace(['App\\\\', '\\\\'], ['', '/'], $class) . '.php';\n    if (is_file($file)) {\n        require $file;\n    }\n});\n",
  'README.md': '# shop\n\nA tiny cart library.\n',
  'src/Cart.php': "<?php\n\nnamespace App;\n\nclass Cart\n{\n    /** @var array<string, array{price: float, qty: int}> */\n    private array $items = [];\n\n    public function add(string $sku, float $price, int $qty = 1): void\n    {\n        $this->items[$sku] = ['price' => $price, 'qty' => ($this->items[$sku]['qty'] ?? 0) + $qty];\n    }\n\n    public function total(): float\n    {\n        $sum = 0.0;\n        foreach ($this->items as $item) {\n            $sum += $item['price'] * $item['qty'];\n        }\n        return $sum;\n    }\n}\n",
  'src/Money.php': "<?php\n\nnamespace App;\n\nfinal class Money\n{\n    public static function format(float $amount): string\n    {\n        return '$' . number_format($amount, 2);\n    }\n}\n",
};

/** A larger Node project — eight services over one store — for a task that has to touch most of it. */
const svc = (name: string, body: string) => `const { tables, nextId } = require('../store');\nconst { NotFoundError } = require('../lib/errors');\n${name ? `const ${name};\n` : ''}\n${body}`;
const BASE_BIG: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop-api', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# shop-api\n\nIn-memory services for a small shop: users, products, inventory, orders, coupons, payments, reviews, shipping.\n',
  'src/store.js': "const tables = { users: new Map(), products: new Map(), stock: new Map(), orders: new Map(), coupons: new Map(), payments: new Map(), reviews: new Map(), shipments: new Map() };\nlet seq = 0;\n\nfunction nextId(prefix) {\n  seq += 1;\n  return prefix + seq;\n}\n\nfunction reset() {\n  for (const t of Object.values(tables)) t.clear();\n  seq = 0;\n}\n\nmodule.exports = { tables, nextId, reset };\n",
  'src/lib/errors.js': "class AppError extends Error {\n  constructor(message) {\n    super(message);\n    this.name = this.constructor.name;\n  }\n}\n\nclass NotFoundError extends AppError {}\n\nmodule.exports = { AppError, NotFoundError };\n",
  'src/services/users.js': svc('', "function createUser({ name, email }) {\n  const user = { id: nextId('u'), name, email };\n  tables.users.set(user.id, user);\n  return user;\n}\n\nfunction getUser(id) {\n  const user = tables.users.get(id);\n  if (!user) throw new NotFoundError('user ' + id);\n  return user;\n}\n\nmodule.exports = { createUser, getUser };\n"),
  'src/services/products.js': svc('', "function createProduct({ name, price }) {\n  const product = { id: nextId('p'), name, price };\n  tables.products.set(product.id, product);\n  return product;\n}\n\nfunction getProduct(id) {\n  const product = tables.products.get(id);\n  if (!product) throw new NotFoundError('product ' + id);\n  return product;\n}\n\nmodule.exports = { createProduct, getProduct };\n"),
  'src/services/inventory.js': svc("{ getProduct } = require('./products')", "function setStock({ productId, qty }) {\n  getProduct(productId);\n  tables.stock.set(productId, qty);\n  return { productId, qty };\n}\n\nfunction getStock(productId) {\n  return tables.stock.get(productId) ?? 0;\n}\n\nmodule.exports = { setStock, getStock };\n"),
  'src/services/orders.js': svc("{ getUser } = require('./users');\nconst { getProduct } = require('./products')", "function createOrder({ userId, items }) {\n  getUser(userId);\n  const total = items.reduce((sum, item) => sum + getProduct(item.productId).price * item.qty, 0);\n  const order = { id: nextId('o'), userId, items, total };\n  tables.orders.set(order.id, order);\n  return order;\n}\n\nfunction getOrder(id) {\n  const order = tables.orders.get(id);\n  if (!order) throw new NotFoundError('order ' + id);\n  return order;\n}\n\nmodule.exports = { createOrder, getOrder };\n"),
  'src/services/coupons.js': svc('', "function createCoupon({ code, percent }) {\n  const coupon = { id: nextId('c'), code, percent };\n  tables.coupons.set(code, coupon);\n  return coupon;\n}\n\nfunction applyCoupon(order, code) {\n  const coupon = tables.coupons.get(code);\n  if (!coupon) throw new NotFoundError('coupon ' + code);\n  return order.total * (1 - coupon.percent / 100);\n}\n\nmodule.exports = { createCoupon, applyCoupon };\n"),
  'src/services/payments.js': svc("{ getOrder } = require('./orders')", "function createPayment({ orderId, amount, method }) {\n  getOrder(orderId);\n  const payment = { id: nextId('pay'), orderId, amount, method };\n  tables.payments.set(payment.id, payment);\n  return payment;\n}\n\nmodule.exports = { createPayment };\n"),
  'src/services/reviews.js': svc("{ getProduct } = require('./products')", "function createReview({ productId, rating, text }) {\n  getProduct(productId);\n  const review = { id: nextId('r'), productId, rating, text };\n  tables.reviews.set(review.id, review);\n  return review;\n}\n\nmodule.exports = { createReview };\n"),
  'src/services/shipping.js': svc("{ getOrder } = require('./orders')", "function createShipment({ orderId, address }) {\n  getOrder(orderId);\n  const shipment = { id: nextId('s'), orderId, address, status: 'pending' };\n  tables.shipments.set(shipment.id, shipment);\n  return shipment;\n}\n\nmodule.exports = { createShipment };\n"),
  'src/index.js': "module.exports = {\n" + ['users', 'products', 'inventory', 'orders', 'coupons', 'payments', 'reviews', 'shipping'].map((n) => `  ...require('./services/${n}'),\n`).join('') + "};\n",
  'test/services.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst s = require('../src');\nconst { reset } = require('../src/store');\n\ntest.beforeEach(() => reset());\n\ntest('an order totals its items', () => {\n  const u = s.createUser({ name: 'Ann', email: 'ann@example.com' });\n  const p = s.createProduct({ name: 'Pen', price: 2 });\n  s.setStock({ productId: p.id, qty: 10 });\n  const o = s.createOrder({ userId: u.id, items: [{ productId: p.id, qty: 3 }] });\n  assert.strictEqual(o.total, 6);\n  assert.strictEqual(s.getStock(p.id), 10);\n});\n\ntest('a coupon discounts an order', () => {\n  const u = s.createUser({ name: 'Bo', email: 'bo@example.com' });\n  const p = s.createProduct({ name: 'Mug', price: 10 });\n  const o = s.createOrder({ userId: u.id, items: [{ productId: p.id, qty: 2 }] });\n  s.createCoupon({ code: 'TEN', percent: 10 });\n  assert.strictEqual(s.applyCoupon(o, 'TEN'), 18);\n});\n\ntest('payments, reviews and shipments attach to existing records', () => {\n  const u = s.createUser({ name: 'Cy', email: 'cy@example.com' });\n  const p = s.createProduct({ name: 'Cap', price: 5 });\n  const o = s.createOrder({ userId: u.id, items: [{ productId: p.id, qty: 1 }] });\n  assert.strictEqual(s.createPayment({ orderId: o.id, amount: 5, method: 'card' }).amount, 5);\n  assert.strictEqual(s.createReview({ productId: p.id, rating: 4, text: 'nice' }).rating, 4);\n  assert.strictEqual(s.createShipment({ orderId: o.id, address: '1 Main St' }).status, 'pending');\n  assert.throws(() => s.createPayment({ orderId: 'nope', amount: 1, method: 'card' }), /order nope/);\n});\n",
};

interface Task {
  id: string;
  prompt: string;
  fixture?: 'node' | 'php' | 'big';
  /** 'plan': plan mode proposes, the bench approves and executes it the way the app's Execute does. */
  mode?: 'agent' | 'plan';
  /** Plan mode: files the proposed plan must name — the "did it find the right code" check. */
  planFiles?: string[];
  setup?: (files: Record<string, string>) => void;
  /** Code run in the finished workspace — Node (`assert` in scope) or PHP (`eq($actual, $expected, $label)`
   *  in scope, vendor/autoload.php loaded) — failing on a wrong result. */
  check?: string;
  /** Files the model must leave byte-identical. */
  frozen?: string[];
  /** Read-only: nothing may change, and the reply must match every pattern. */
  answer?: RegExp[];
}

const TASKS: Task[] = [
  {
    id: 'fix-add',
    prompt: 'add() in src/math.js returns wrong results. Fix it.',
    setup: (f) => { f['src/math.js'] = f['src/math.js'].replace('a + b', 'a - b'); },
    check: "const { add } = require('./src/math'); assert.strictEqual(add(2, 3), 5); assert.strictEqual(add(-4, 1), -3);",
  },
  {
    id: 'failing-test',
    prompt: 'npm test is failing. Find the cause and fix the code, not the tests.',
    setup: (f) => { f['src/billing/invoice.js'] = f['src/billing/invoice.js'].replace('id.trim()', 'id'); },
    frozen: ['src/billing/invoice.test.js'],
    check: "const { parseInvoice } = require('./src/billing/invoice'); assert.strictEqual(parseInvoice(' B2 ,3').id, 'B2');",
  },
  {
    id: 'feature',
    prompt: "Invoices can carry an optional discount percentage as a third field: parseInvoice('A1,100,10') should return "
      + "{ id: 'A1', total: 100, discount: 10 }, and discount is 0 when the field is missing. Add invoiceTotal(invoice) in "
      + 'src/billing/total.js that returns the total after the discount, export it from src/index.js, and add tests for both.',
    check: "const { parseInvoice } = require('./src/billing/invoice');"
      + " assert.deepStrictEqual(parseInvoice('A1,100,10'), { id: 'A1', total: 100, discount: 10 });"
      + " assert.strictEqual(parseInvoice('A1,100').discount, 0);"
      + " assert.strictEqual(require('./src').invoiceTotal({ id: 'x', total: 200, discount: 25 }), 150);"
      + " const fs = require('fs'), path = require('path'); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);"
      + " assert.ok(walk('src').some((f) => /\\.test\\.js$/.test(f) && fs.readFileSync(f, 'utf8').includes('invoiceTotal')), 'no test covers invoiceTotal');",
  },
  {
    id: 'rename',
    prompt: 'Rename the function mul to multiply everywhere: definition, exports, callers and tests.',
    check: "const fs = require('fs'), path = require('path'); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);"
      + " const left = walk('src').filter((f) => /\\bmul\\b/.test(fs.readFileSync(f, 'utf8'))); assert.deepStrictEqual(left, [], 'mul still in ' + left.join(', '));"
      + " assert.strictEqual(require('./src').multiply(3, 4), 12); assert.strictEqual(require('./src/report').lineTotal(2, 5), 10);",
  },
  {
    id: 'explain',
    prompt: "Where does an invoice line's total get converted to a number, and what does the total become when that field "
      + 'is not numeric? Answer only; do not change any files.',
    answer: [/invoice\.js/, /NaN/],
  },
  {
    id: 'php-fix',
    fixture: 'php',
    prompt: 'Cart::total() in src/Cart.php ignores the quantity. Fix it.',
    setup: (f) => { f['src/Cart.php'] = f['src/Cart.php'].replace("$item['price'] * $item['qty']", "$item['price']"); },
    check: "$c = new App\\Cart(); $c->add('a', 2.5, 4); $c->add('b', 1.0); eq($c->total(), 11.0, 'total');",
  },
  {
    id: 'php-feature',
    fixture: 'php',
    prompt: 'Add discounts to App\\Cart: applyDiscount(float $percent) stores a percentage and throws InvalidArgumentException '
      + 'outside 0-100; total() returns the discounted total rounded to 2 decimals; and a new formattedTotal(): string '
      + 'returns Money::format() of that total.',
    check: "$c = new App\\Cart(); $c->add('a', 10.0, 3); $c->applyDiscount(15); eq($c->total(), 25.5, 'discounted total');"
      + " eq($c->formattedTotal(), '$25.50', 'formattedTotal');"
      + " $t = false; try { $c->applyDiscount(150); } catch (InvalidArgumentException $e) { $t = true; } eq($t, true, 'rejects 150');"
      + " $d = new App\\Cart(); $d->add('b', 1.0, 3); $d->applyDiscount(10); eq($d->total(), 2.7, 'rounded');",
  },
];

TASKS.push({
  id: 'big-validate',
  fixture: 'big',
  prompt: 'Add input validation to every create*/set* function in src/services. Add a ValidationError class to src/lib/errors.js '
    + '(extends AppError, with a `field` property naming the first invalid property — for an order item, the item\'s property, '
    + 'e.g. "qty") and throw it for invalid input, before any lookup or write:\n'
    + '- name, email, code, text, address, method and the ids (userId, productId, orderId) must be non-empty strings; email must also contain "@"\n'
    + '- price and amount must be finite numbers > 0\n'
    + '- qty must be an integer >= 1 in order items, and an integer >= 0 for setStock\n'
    + '- percent must be a number from 1 to 100; rating an integer from 1 to 5\n'
    + '- items must be a non-empty array\n'
    + 'Keep the existing tests passing and add tests covering the validation.',
  check: "const s = require('./src'); const { ValidationError, AppError } = require('./src/lib/errors'); require('./src/store').reset();"
    + " const bad = (fn, field) => { try { fn(); } catch (e) { assert.ok(e instanceof ValidationError && e instanceof AppError, field + ': got ' + (e && e.constructor && e.constructor.name)); assert.strictEqual(e.field, field); return; } assert.fail('no ValidationError for ' + field); };"
    + " bad(() => s.createUser({ name: '', email: 'a@b.c' }), 'name'); bad(() => s.createUser({ name: 'A', email: 'nope' }), 'email');"
    + " bad(() => s.createProduct({ name: 'P', price: 0 }), 'price'); bad(() => s.createProduct({ name: 'P', price: NaN }), 'price');"
    + " const u = s.createUser({ name: 'A', email: 'a@b.c' }); const p = s.createProduct({ name: 'P', price: 5 });"
    + " bad(() => s.setStock({ productId: p.id, qty: -1 }), 'qty'); s.setStock({ productId: p.id, qty: 0 });"
    + " bad(() => s.createOrder({ userId: u.id, items: [] }), 'items'); bad(() => s.createOrder({ userId: u.id, items: [{ productId: p.id, qty: 0 }] }), 'qty');"
    + " const o = s.createOrder({ userId: u.id, items: [{ productId: p.id, qty: 2 }] }); assert.strictEqual(o.total, 10);"
    + " bad(() => s.createCoupon({ code: 'X', percent: 0 }), 'percent'); bad(() => s.createCoupon({ code: '', percent: 10 }), 'code');"
    + " bad(() => s.createPayment({ orderId: o.id, amount: -5, method: 'card' }), 'amount'); bad(() => s.createPayment({ orderId: o.id, amount: 5, method: '' }), 'method');"
    + " bad(() => s.createReview({ productId: p.id, rating: 6, text: 'ok' }), 'rating'); bad(() => s.createReview({ productId: p.id, rating: 2.5, text: 'ok' }), 'rating');"
    + " bad(() => s.createShipment({ orderId: o.id, address: '' }), 'address'); s.createShipment({ orderId: o.id, address: 'X st' });"
    + " const fs = require('fs'); assert.ok(fs.readdirSync('test').some((f) => fs.readFileSync('test/' + f, 'utf8').includes('ValidationError')), 'no test covers ValidationError');",
});

const planOf = (id: string, planFiles: string[]): Task => ({ ...TASKS.find((t) => t.id === id)!, id: `plan-${id}`, mode: 'plan', planFiles });
TASKS.push(
  planOf('feature', ['src/billing/invoice.js', 'src/billing/total.js', 'src/index.js']),
  planOf('php-feature', ['src/Cart.php']),
);

const PHP_EQ = 'function eq($a, $b, $m) { if ($a !== $b) { fwrite(STDERR, "AssertionError: $m: " . var_export($a, true) . "\\n"); exit(1); } }';
const BENCH_ROOT = process.env.BENCH_DIR ?? join(homedir(), '.cache', 'tiermux-bench');

/* ---------- workspace + grading ---------- */

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : walk(dir, r);
    return [r];
  });
}

function snapshot(dir: string): Map<string, string> {
  return new Map(walk(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

function seed(task: Task): { dir: string; files: Record<string, string> } {
  const files = { ...(task.fixture === 'php' ? BASE_PHP : task.fixture === 'big' ? BASE_BIG : BASE) };
  task.setup?.(files);
  mkdirSync(BENCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(BENCH_ROOT, `${task.id}-`));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  if (task.fixture !== 'php') mkdirSync(join(dir, 'node_modules')); // "installed", so the engine's verify gate runs as it would for a user
  return { dir, files };
}

function grade(task: Task, dir: string, before: Map<string, string>, reply: string, plan?: ProposedPlan): string[] {
  const fails: string[] = [];
  if (task.mode === 'plan') {
    if (!plan) fails.push('no plan (exitPlanMode not called)');
    else {
      const named = new Set(plan.steps.flatMap((st) => st.files ?? []).map((f) => f.replace(/^\.?\//, '')));
      const missing = (task.planFiles ?? []).filter((f) => !named.has(f));
      if (missing.length) fails.push(`plan misses ${missing.join(', ')}`);
    }
  }
  const after = snapshot(dir);
  if (task.answer) {
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
    if (changed.length) fails.push(`changed ${changed.join(', ')}`);
    for (const re of task.answer) if (!re.test(reply)) fails.push(`reply lacks ${re}`);
    return fails;
  }
  for (const f of task.frozen ?? []) if (before.get(f) !== after.get(f)) fails.push(`edited frozen ${f}`);
  const php = task.fixture === 'php';
  if (task.check) {
    const r = php
      ? childProcess.spawnSync('php', ['-r', `require 'vendor/autoload.php'; ${PHP_EQ} ${task.check}`], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
      : childProcess.spawnSync(process.execPath, ['-e', `const assert = require('node:assert'); ${task.check}`], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) fails.push(`check: ${`${r.stderr}\n${r.stdout}`.match(/^\s*(\w*Error\b.*|.*\b(Fatal|Parse) error\b.*)$/m)?.[1].slice(0, 120) ?? `exit ${r.status}`}`);
  }
  if (php) {
    for (const f of [...after.keys()].filter((k) => k.endsWith('.php'))) {
      const l = childProcess.spawnSync('php', ['-l', f], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      if (l.status !== 0) fails.push(`php -l ${f}`);
    }
    return fails;
  }
  const t = childProcess.spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  if (t.status !== 0) fails.push(`tests: ${t.stdout.match(/# fail \d+/)?.[0] ?? `exit ${t.status}`}`);
  return fails;
}

/* ---------- instrumentation: diag trace lines, provider requests, child processes ---------- */

interface Probe { diag: string[]; requests: number; procMs: number; procs: string[]; steps: string[][] }
let probe: Probe | undefined;

function instrument(): void {
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig = { 'agent.diagTrace': true };
  (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => ({ appendLine() {}, show() {}, dispose() {} });

  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[tiermux][diag]')) {
      probe?.diag.push(line);
      if (line.includes('engine.step · ')) probe?.steps.push([]);
      return;
    }
    log(...a);
  };

  const fetch0 = globalThis.fetch;
  globalThis.fetch = ((...a: Parameters<typeof fetch>) => { if (probe) probe.requests++; return fetch0(...a); }) as typeof fetch;

  const cp = require('child_process') as { spawn: typeof childProcess.spawn };
  const spawn0 = cp.spawn;
  cp.spawn = ((...a: Parameters<typeof spawn0>) => {
    const child = spawn0(...a);
    const p = probe;
    const t0 = Date.now();
    child.on('close', () => { if (p) { p.procMs += Date.now() - t0; p.procs.push(String((a[1] as string[] | undefined)?.at(-1) ?? a[0]).slice(0, 60)); } });
    return child;
  }) as typeof spawn0;
}

/* ---------- one run ---------- */

function toolLabel(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const v = a.pattern ?? a.path ?? a.command ?? a.query ?? a.symbol ?? a.name;
  return v === undefined ? name : `${name}(${String(Array.isArray(v) ? v.join(',') : v).slice(0, 40)})`;
}

interface Run {
  task: string; rep: number; pass: boolean; fails: string[];
  wallMs: number; firstActionMs?: number; ttftMs?: number; firstChunkMs: number;
  steps: number; toolCalls: number; toolErrors: number; asks: number;
  requests: number; procMs: number; procs: string[];
  /** Tool calls per model step, e.g. [['readFile(src/a.js)', 'grep(add)'], []] — [] is a tool-less step. */
  trace: string[][]; repeats: number;
  /** Writes whose result carried the per-file syntax check's failure note. */
  syntaxFlags: number;
  /** Start of the final reply — kept to see why a run ended where it did. */
  reply: string;
  /** What the failed tool calls said (first 12) — why a run churned. */
  toolErrorText: string[];
  /** Tool approvals the policy sent to the user (plan mode asks before every shell command). */
  permAsks: number;
  /** Plan mode: the proposing turn alone, and the plan it produced. */
  planMs?: number; planRequests?: number; planSteps?: number; planFiles?: string[]; planTraceLen?: number;
  inputTokens: number; outputTokens: number; failovers: number;
  models: string[]; verify?: string; finish?: string; stop?: string; paused?: boolean; error?: string;
}

async function runOnce(task: Task, rep: number, pinned: string | undefined, timeoutMs: number): Promise<Run> {
  const { dir } = seed(task);
  const before = snapshot(dir);
  const p: Probe = { diag: [], requests: 0, procMs: 0, procs: [], steps: [] };
  const tools = new Map<string, string>();
  const at = new Map<string, [string[], number]>();
  const models = new Set<string>();
  let asks = 0, inputTokens = 0, outputTokens = 0, failovers = 0, syntaxFlags = 0, permAsks = 0;
  let plan: ProposedPlan | undefined;
  const toolErrorText: string[] = [];
  let planMs: number | undefined, planRequests: number | undefined, planTraceLen: number | undefined;
  let firstActionMs: number | undefined;
  let result: AgentResult | undefined;
  let error: string | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('bench timeout')), timeoutMs);
  const t0 = Date.now();
  probe = p;
  invalidatePromptContext();
  if (process.env.GRADER_CHECK) __setEngineModelForTests(createMockModel(Array.from({ length: 5 }, () => ({ text: 'Done.' })), 'noop'));
  try {
    const opts = {
      mode: 'agent', effort: 'medium', autoApprove: true, sessionId: `bench-${task.id}-${rep}-${t0}`,
      pinnedModel: pinned, abortSignal: abort.signal, verifyFixRounds: 1,
      onChunk: () => {}, onReasoning: () => {}, onStep: () => {}, onTodos: () => {},
      onFailover: () => { failovers++; },
      usageSink: (u) => { inputTokens += u.inputTokens; outputTokens += u.outputTokens; },
      onModel: (platform, model) => { models.add(`${platform}::${model}`); },
      onTool: (e) => {
        firstActionMs ??= Date.now() - t0;
        if (!tools.has(e.toolCallId)) { const st = p.steps.at(-1) ?? (p.steps[0] = []); st.push(toolLabel(e.name, e.args)); at.set(e.toolCallId, [st, st.length - 1]); }
        // A tool that returns { error } still reports 'done'; its detail is that JSON.
        const failed = e.state === 'error' || (e.state === 'done' && /^\{\s*"error"/.test(e.detail ?? ''));
        tools.set(e.toolCallId, failed ? 'error' : e.state);
        const [st, i] = at.get(e.toolCallId) ?? [];
        if (failed && st && i !== undefined && !st[i].endsWith('✗')) st[i] += '✗';
        if (failed && toolErrorText.length < 12) toolErrorText.push(`${e.name}: ${(e.detail ?? '').replace(/\s+/g, ' ').slice(0, 160)} ← args ${JSON.stringify(e.args ?? null).slice(0, 240)}`);
        if (e.state === 'done' && e.detail?.includes('Syntax check failed') && st && i !== undefined) { syntaxFlags++; st[i] += '⚠'; }
      },
      onAskUser: async () => { asks++; return { status: 'answered' as const, answers: ['Use your best judgment and proceed.'] }; },
      onPermissionAsk: async () => { permAsks++; return 'once' as const; },
      onError: (m: string) => { error = m; },
    } as Omit<AgentOpts, 'messages'>;
    const ask = [{ role: 'user' as const, content: task.prompt }];
    result = await runWithWorkspaceRoot(dir, async () => {
      if (task.mode !== 'plan') return runAgentStream({ ...opts, messages: ask });
      const planned = await runPlanStream({ ...opts, mode: 'plan', messages: ask });
      planMs = Date.now() - t0; planRequests = p.requests; planTraceLen = p.steps.length;
      plan = planned.plan;
      if (!plan || plan.outcome === 'no-change') return planned;
      // Mirrors handleExecutePlan + executePlanRun (chatViewProvider.ts): history, prompt and todos.
      const stepsText = formatPlanForCard(plan);
      const steps = planStepsToTodos(stepsText).map((t) => t.content);
      const prompt = steps.length >= 2
        ? `Execute this approved plan completely, step by step, using your tools. Steps marked [done] are already finished — skip them. When finished, reply with a short summary of what changed.\n\n${steps.map((st, i) => `${i + 1}. ${st}`).join('\n')}`
        : `Carry out this approved plan now, step by step:\n\n${stepsText}`;
      return runAgentStream({
        ...opts,
        todos: steps.map((content, i) => ({ content, status: i === 0 ? 'in_progress' as const : 'pending' as const })),
        messages: [...ask, ...capForHistory(planned.workMessages ?? []), { role: 'assistant', content: `Approved plan:\n\n${stepsText}` }, { role: 'user', content: prompt }],
      });
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    probe = undefined;
    __setEngineModelForTests(undefined);
  }
  const wallMs = Date.now() - t0;
  const reply = result?.text ?? '';
  const fails = error && !result ? [`error: ${error}`] : grade(task, dir, before, reply, plan);
  if (process.env.KEEP) console.log(`   kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });

  const num = (re: RegExp) => p.diag.map((l) => re.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  return {
    task: task.id, rep, pass: fails.length === 0, fails,
    wallMs, firstActionMs, ttftMs: num(/engine\.ttft · (\d+)ms/)[0], firstChunkMs: num(/rp\.ttft · .* first chunk after (\d+)ms/).reduce((a, b) => a + b, 0),
    steps: num(/engine\.step · step (\d+) took/).length,
    toolCalls: tools.size, toolErrors: [...tools.values()].filter((s) => s === 'error').length, asks,
    requests: p.requests, procMs: p.procMs, procs: p.procs,
    inputTokens, outputTokens, failovers,
    trace: p.steps, syntaxFlags, reply: reply.slice(0, fails.length ? 4000 : 400), permAsks, toolErrorText,
    planMs, planRequests, planTraceLen, planSteps: plan?.steps.length, planFiles: plan ? [...new Set(plan.steps.flatMap((st) => st.files ?? []))] : undefined, repeats: p.steps.flat().filter((t, i, all) => all.indexOf(t) !== i).length,
    models: [...models], verify: result?.verifyOutcome, finish: result?.finishReason, stop: result?.stopReason,
    paused: result?.paused, error,
  };
}

/* ---------- report ---------- */

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const sec = (ms: number | undefined) => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const pad = (s: string | number, n: number) => String(s).padEnd(n);

interface Summary { task: string; passed: number; runs: number; wallMs: number; tokens: number; requests: number; steps: number }
function summarize(runs: Run[]): Summary[] {
  const by = new Map<string, Run[]>();
  for (const r of runs) by.set(r.task, [...(by.get(r.task) ?? []), r]);
  return [...by].map(([task, rs]) => ({
    task, passed: rs.filter((r) => r.pass).length, runs: rs.length,
    wallMs: median(rs.map((r) => r.wallMs)), tokens: median(rs.map((r) => r.inputTokens + r.outputTokens)),
    requests: median(rs.map((r) => r.requests)), steps: median(rs.map((r) => r.steps)),
  }));
}

function delta(now: number, then: number | undefined, fmt: (n: number) => string): string {
  if (then === undefined) return fmt(now);
  const d = now - then;
  return `${fmt(now)} (${d > 0 ? '+' : ''}${fmt(d)})`;
}

function printRun(r: Run): void {
  console.log(`${pad(r.task, 13)}${pad(r.rep, 4)}${pad(r.pass ? 'PASS' : 'FAIL', 6)}${pad(sec(r.wallMs), 7)}${pad(sec(r.firstActionMs), 7)}${pad(sec(r.ttftMs), 7)}`
    + `${pad(r.steps, 6)}${pad(`${r.toolCalls}/${r.toolErrors}`, 7)}${pad(r.asks, 5)}${pad(r.requests, 5)}${pad(`${Math.round(r.inputTokens / 1000)}k/${r.outputTokens}`, 11)}`
    + `${pad(sec(r.procMs), 7)}${pad(r.verify ?? '-', 11)}${r.models.join(',') || '-'}${r.fails.length ? `   ✗ ${r.fails.join('; ')}` : ''}`);
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const store = new Map<string, unknown>();
  const mem = { get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d), update: async (k: string, v: unknown) => { store.set(k, v); }, keys: () => [...store.keys()] };
  const catalog = new Catalog(ROOT);
  if (!(await catalog.refresh(process.env.CATALOG_URL ?? WORKER, mem as never))) console.log('worker unreachable — using the bundled catalog');
  const secretMap = new Map<string, string>();
  const secrets = new SecretStore({
    get: async (k: string) => secretMap.get(k), store: async (k: string, v: string) => { secretMap.set(k, v); },
    delete: async (k: string) => { secretMap.delete(k); }, onDidChange: () => ({ dispose() {} }),
  } as never);
  const keyed: string[] = [];
  for (const { platform } of allPlatformInfo()) {
    const key = process.env[`TIERMUX_KEY_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (key) { await secrets.set(platform as Platform, key); keyed.push(platform); }
  }
  setModelSources({ catalog, settings: new SettingsStore(mem as never, catalog), secrets });

  const onlyTasks = process.env.TASKS?.split(',').map((s) => s.trim()).filter(Boolean);
  const tasks = TASKS.filter((t) => !onlyTasks || onlyTasks.includes(t.id));
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);
  const timeoutMs = Number(process.env.TASK_TIMEOUT_MS ?? 600_000) || 600_000;
  const pinned = process.env.MODEL?.trim() || undefined;
  const commit = childProcess.spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = childProcess.spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';

  console.log(`agent bench · ${commit}${dirty ? '+dirty' : ''} · ${pinned ?? 'Auto'} · keys: ${keyed.join(',') || 'none (keyless only)'} · ${tasks.length} task(s) × ${repeat}\n`);
  console.log(`${pad('task', 13)}${pad('#', 4)}${pad('', 6)}${pad('wall', 7)}${pad('1st', 7)}${pad('ttft', 7)}${pad('steps', 6)}${pad('tools', 7)}${pad('ask', 5)}${pad('req', 5)}${pad('tok in/out', 11)}${pad('proc', 7)}${pad('verify', 11)}model`);
  instrument();
  const runs: Run[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= repeat; rep++) {
      const r = await runOnce(task, rep, pinned, timeoutMs);
      runs.push(r);
      printRun(r);
    }
  }

  const baseline = process.env.BASELINE ? summarize((JSON.parse(readFileSync(process.env.BASELINE, 'utf8')) as { runs: Run[] }).runs) : undefined;
  console.log(`\n${pad('task', 13)}${pad('pass', 8)}${pad('median wall s', 22)}${pad('median tokens', 24)}${pad('median req', 16)}median steps${baseline ? `   (vs ${process.env.BASELINE})` : ''}`);
  for (const s of summarize(runs)) {
    const b = baseline?.find((x) => x.task === s.task);
    console.log(`${pad(s.task, 13)}${pad(`${s.passed}/${s.runs}${b ? ` (${b.passed}/${b.runs})` : ''}`, 8)}${pad(delta(s.wallMs, b?.wallMs, (n) => (n / 1000).toFixed(1)), 22)}`
      + `${pad(delta(s.tokens, b?.tokens, (n) => String(Math.round(n))), 24)}${pad(delta(s.requests, b?.requests, String), 16)}${delta(s.steps, b?.steps, String)}`);
  }
  console.log('\ntool calls per step (· = no tools, ↻ = repeated call, ✗ = failed, ⚠ = syntax check flagged the write):');
  for (const r of runs) {
    const seen = new Set<string>();
    const fmt = (t: string) => { const again = seen.has(t); seen.add(t); return again ? `↻${t}` : t; };
    const shown = r.trace.map((st) => (st.length ? st.map(fmt).join(' + ') : '·'));
    if (r.planTraceLen !== undefined) shown.splice(r.planTraceLen, 0, '‖ EXECUTE ‖');
    console.log(`${r.task}#${r.rep}: ${shown.join(' | ')}`);
    if (r.planMs !== undefined) console.log(`   plan: ${sec(r.planMs)}s, ${r.planRequests} req, ${r.planSteps ?? 0} step(s), files ${(r.planFiles ?? []).join(', ') || '-'}; asks ${r.asks}, permission prompts ${r.permAsks}`);
    if (!r.pass) console.log(`   reply: ${JSON.stringify(r.reply.slice(0, 300))}`);
    for (const t of r.pass ? [] : r.toolErrorText ?? []) console.log(`   ✗ ${t}`);
  }
  const passed = runs.filter((r) => r.pass).length;
  if (process.env.GRADER_CHECK) {
    console.log(passed === 0 ? '\ngrader OK: doing nothing fails every task' : `\ngrader BROKEN: ${runs.filter((r) => r.pass).map((r) => r.task).join(', ')} passed with no work`);
    process.exit(passed === 0 ? 0 : 1);
  }
  console.log(`\npassed ${passed}/${runs.length} · total wall ${sec(runs.reduce((a, r) => a + r.wallMs, 0))}s`);

  mkdirSync(join(ROOT, '.benchmarks'), { recursive: true });
  const out = join(ROOT, '.benchmarks', `agent-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify({ commit, dirty, model: pinned ?? 'auto', keyed, node: process.version, repeat, runs }, null, 2));
  console.log(`details: ${out.slice(ROOT.length + 1)}`);
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
