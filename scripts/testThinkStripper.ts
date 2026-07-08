// Quick test for ThinkStripper logic
import { ThinkStripper, stripThinkTags } from '../src/router/router';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

function assertEqual(actual: string, expected: string, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'Assertion failed'}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
  }
}

// Test stripThinkTags (non-streaming)
test('stripThinkTags: removes complete think block', () => {
  assertEqual(
    stripThinkTags('<think>This is reasoning</think>The answer'),
    'The answer'
  );
});

test('stripThinkTags: removes dangling think block', () => {
  assertEqual(
    stripThinkTags('<think>This is reasoning without close'),
    ''
  );
});

test('stripThinkTags: removes multiple think blocks', () => {
  assertEqual(
    stripThinkTags('<think>first</think>text<think>second</think>more text'),
    'textmore text'
  );
});

test('stripThinkTags: preserves text without think tags', () => {
  assertEqual(
    stripThinkTags('Just normal text'),
    'Just normal text'
  );
});

test('stripThinkTags: handles empty input', () => {
  assertEqual(stripThinkTags(''), '');
});

// Test ThinkStripper (streaming)
test('ThinkStripper: strips complete think block in one chunk', () => {
  const stripper = new ThinkStripper();
  const result = stripper.feed('<think>reasoning</think>answer');
  assertEqual(result, 'answer');
});

test('ThinkStripper: handles think tag split across chunks', () => {
  const stripper = new ThinkStripper();
  let result = stripper.feed('<think>reas');
  assertEqual(result, '', 'First chunk should emit nothing');
  
  result = stripper.feed('oning</think>');
  assertEqual(result, '', 'Second chunk should emit nothing');
  
  result = stripper.feed('answer');
  assertEqual(result, 'answer', 'Third chunk should emit answer');
});

test('ThinkStripper: handles partial <think> at chunk boundary', () => {
  const stripper = new ThinkStripper();
  let result = stripper.feed('text<th');
  assertEqual(result, 'text', 'Should emit text before partial tag');
  
  result = stripper.feed('ink>reasoning');
  assertEqual(result, '', 'Should hold back after seeing complete <think>');
  
  result = stripper.feed('</think>answer');
  assertEqual(result, 'answer', 'Should emit answer after </think>');
});

test('ThinkStripper: flush discards dangling think', () => {
  const stripper = new ThinkStripper();
  stripper.feed('text<think>reasoning');
  const result = stripper.flush();
  assertEqual(result, '', 'Flush should discard incomplete think block');
});

test('ThinkStripper: flush emits remaining text', () => {
  const stripper = new ThinkStripper();
  const fed = stripper.feed('text');
  // If feed() already emitted the text (no partial tags), flush returns empty
  // If feed() held back text (partial tag detected), flush returns it
  const flushed = stripper.flush();
  const total = fed + flushed;
  assertEqual(total, 'text', 'Combined feed+flush should emit all text');
});

test('ThinkStripper: multiple think blocks', () => {
  const stripper = new ThinkStripper();
  let result = stripper.feed('<think>first</think>text');
  assertEqual(result, 'text');
  
  result = stripper.feed('<think>second</think>more');
  assertEqual(result, 'more');
});

test('ThinkStripper: case insensitive tags', () => {
  const stripper = new ThinkStripper();
  const result = stripper.feed('<think>reasoning</think>answer');
  assertEqual(result, 'answer');
});

console.log('\nAll tests passed! ✓');
