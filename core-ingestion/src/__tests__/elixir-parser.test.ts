import { parseElixir, ElixirFunction, ElixirStatement } from './elixir-parser';

const SAMPLE = `
defmodule MyApp.User do
  use GenServer

  alias MyApp.Repo
  import Ecto.Query
  require Logger

  defstruct [:name, :email, :age]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def init(state) do
    {:ok, state}
  end

  defp validate(user) do
    :ok
  end

  defmacro my_macro(x) do
    quote do: unquote(x)
  end
end
`.trim();

test('parses module name', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  expect(ast.modules[0].name).toBe('MyApp.User');
});

test('detects OTP behaviour from use', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  expect(ast.modules[0].behaviours).toContain('GenServer');
});

test('parses public functions', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  const pub = ast.modules[0].functions.filter((f: ElixirFunction) => !f.isPrivate);
  expect(pub.map((f: ElixirFunction) => f.name)).toContain('start_link');
});

test('parses private functions', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  const priv = ast.modules[0].functions.filter((f: ElixirFunction) => f.isPrivate);
  expect(priv[0].name).toBe('validate');
});

test('flags OTP callbacks', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  const init = ast.modules[0].functions.find((f: ElixirFunction) => f.name === 'init');
  expect(init?.isOTPCallback).toBe(true);
});

test('parses struct fields', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  expect(ast.modules[0].structs[0].fields).toEqual(['name', 'email', 'age']);
});

test('parses use/alias/import/require', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  const kinds = ast.modules[0].statements.map((s: ElixirStatement) => s.kind);
  expect(kinds).toContain('use');
  expect(kinds).toContain('alias');
  expect(kinds).toContain('import');
  expect(kinds).toContain('require');
});

test('detects .exs as script', () => {
  const ast = parseElixir('', 'mix.exs');
  expect(ast.isScript).toBe(true);
});

test('parses macros', () => {
  const ast = parseElixir(SAMPLE, 'user.ex');
  expect(ast.modules[0].macros[0].name).toBe('my_macro');
});