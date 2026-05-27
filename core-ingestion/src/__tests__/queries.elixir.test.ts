import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Elixir queries', () => {
  it('captures module, public functions, and private functions', () => {
    const result = parseFile(
      '/repo/user.ex',
      `
defmodule MyApp.User do
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def init(state) do
    {:ok, state}
  end

  defp validate(user) do
    :ok
  end
end
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['MyApp.User', 'start_link', 'init', 'validate']),
    );
  });

  it('captures module as a class-kind entity', () => {
    const result = parseFile(
      '/repo/worker.ex',
      `
defmodule MyApp.Worker do
end
      `,
    );

    expect(result).not.toBeNull();
    const mod = result!.entities.find(e => e.name === 'MyApp.Worker');
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe('class');
  });

  it('captures use/alias/import/require as IMPORTS relationships', () => {
    const result = parseFile(
      '/repo/server.ex',
      `
defmodule MyApp.Server do
  use GenServer
  alias MyApp.Repo
  import Ecto.Query
  require Logger
end
      `,
    );

    expect(result).not.toBeNull();
    const importTargets = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.dstName);
    expect(importTargets).toEqual(expect.arrayContaining(['GenServer', 'MyApp.Repo', 'Ecto.Query', 'Logger']));
  });

  it('captures qualified calls like GenServer.start_link', () => {
    const result = parseFile(
      '/repo/worker.ex',
      `
defmodule MyApp.Worker do
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end
end
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'start_link', predicate: 'CALLS' }),
    );
  });

  it('parses .exs script files', () => {
    const result = parseFile(
      '/repo/mix.exs',
      `
defmodule MyApp.MixProject do
  use Mix.Project

  def project do
    [app: :my_app]
  end
end
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toContain('MyApp.MixProject');
  });

  it('captures defmacro as a function-kind entity', () => {
    const result = parseFile(
      '/repo/macros.ex',
      `
defmodule MyApp.Macros do
  defmacro my_macro(x) do
    quote do: unquote(x)
  end
end
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toContain('my_macro');
  });
});
