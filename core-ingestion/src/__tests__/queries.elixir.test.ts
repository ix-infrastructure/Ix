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
      expect.objectContaining({ dstName: 'GenServer.start_link', predicate: 'CALLS' }),
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

  it('captures defmacro as a macro-kind entity', () => {
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
    const macro = result!.entities.find(e => e.name === 'my_macro');
    expect(macro).toBeDefined();
    expect(macro!.kind).toBe('macro');
  });

  it('captures defprotocol and defimpl as class-kind entities', () => {
    const result = parseFile(
      '/repo/serializer.ex',
      `
defprotocol MyApp.Serializer do
  def serialize(data)
end

defimpl MyApp.Serializer, for: MyApp.User do
  def serialize(data), do: data
end
      `,
    );

    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toContain('MyApp.Serializer');
    const protocol = result!.entities.find(e => e.name === 'MyApp.Serializer');
    expect(protocol!.kind).toBe('class');
  });

  it('does not emit bogus CALLS edges for keywords or self-calls', () => {
    const result = parseFile(
      '/repo/user.ex',
      `
defmodule MyApp.User do
  use GenServer
  alias MyApp.Repo
  import Ecto.Query

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  defp validate(user) do
    Repo.get(User, user.id)
    user |> Map.put(:validated, true) |> Repo.update()
  end
end
      `,
    );

    expect(result).not.toBeNull();
    const callTargets = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);

    expect(callTargets).not.toContain('defmodule');
    expect(callTargets).not.toContain('def');
    expect(callTargets).not.toContain('defp');
    expect(callTargets).not.toContain('use');
    expect(callTargets).not.toContain('alias');
    expect(callTargets).not.toContain('import');
    expect(callTargets).not.toContain('start_link');
    expect(callTargets).not.toContain('validate');
  });

  it('captures guarded functions', () => {
    const result = parseFile(
      '/repo/user.ex',
      `
defmodule MyApp.User do
  def fetch(id) when is_integer(id) do
    {:ok, id}
  end

  defp validate(x) when x > 0 do
    :ok
  end
end
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['fetch', 'validate']),
    );
  });
it('does not emit self-call edge for guarded functions', () => {
    const result = parseFile(
      '/repo/user.ex',
      `
defmodule MyApp.User do
  def fetch(id) when is_integer(id) do
    {:ok, id}
  end
end
      `,
    );

    expect(result).not.toBeNull();
    const callTargets = result!.relationships
      .filter(r => r.predicate === 'CALLS')
      .map(r => r.dstName);
    expect(callTargets).not.toContain('fetch');
  });

    it('captures grouped alias as IMPORTS relationships', () => {
    const result = parseFile(
      '/repo/context.ex',
      `
defmodule MyApp.Context do
  alias MyApp.{User, Repo, Post}
end
      `,
    );

    expect(result).not.toBeNull();
    const importTargets = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.dstName);
    expect(importTargets).toEqual(
      expect.arrayContaining(['User', 'Repo', 'Post']),
    );
  });
});

