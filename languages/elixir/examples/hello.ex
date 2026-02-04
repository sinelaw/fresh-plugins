defmodule Hello do
  @moduledoc """
  A simple hello world module to test Elixir LSP support.
  """

  @doc """
  Says hello to the given name.

  ## Examples

      iex> Hello.greet("World")
      "Hello, World!"

  """
  def greet(name) do
    "Hello, #{name}!"
  end

  def main do
    IO.puts(greet("Fresh Editor"))
  end
end
