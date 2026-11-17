import KeyedMutex from '../src/keyedMutex';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('KeyedMutex', () => {
  test('runs work for the same key one at a time, in order', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    await Promise.all([
      mutex.run('vol1', async () => { events.push('a:start'); await tick(); events.push('a:end'); }),
      mutex.run('vol1', async () => { events.push('b:start'); await tick(); events.push('b:end'); }),
    ]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  test('runs work for different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    await Promise.all([
      mutex.run('vol1', async () => { events.push('a:start'); await tick(); events.push('a:end'); }),
      mutex.run('vol2', async () => { events.push('b:start'); await tick(); events.push('b:end'); }),
    ]);

    expect(events.slice(0, 2)).toEqual(['a:start', 'b:start']);
  });

  test('a failure releases the lock for the next caller', async () => {
    const mutex = new KeyedMutex();

    await expect(mutex.run('vol1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.run('vol1', async () => 'ok')).resolves.toBe('ok');
  });
});
