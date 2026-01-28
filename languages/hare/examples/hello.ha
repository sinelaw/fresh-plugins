// A simple Hare program demonstrating syntax highlighting
use fmt;
use os;

// Define a custom type
type person = struct {
	name: str,
	age: u32,
};

// Function to greet a person
fn greet(p: *person) void = {
	fmt::printfln("Hello, {}! You are {} years old.", p.name, p.age)!;
};

// Main entry point
export fn main() void = {
	const message = "Welcome to Hare!";
	fmt::println(message)!;

	// Numbers demonstration
	let decimal = 42;
	let hex = 0xFF;
	let binary = 0b1010;
	let octal = 0o755;
	let float = 3.14f64;

	// Create a person
	let alice = person {
		name = "Alice",
		age = 30,
	};

	greet(&alice);

	// Control flow
	for (let i = 0u32; i < 5; i += 1) {
		if (i % 2 == 0) {
			fmt::printfln("{} is even", i)!;
		} else {
			fmt::printfln("{} is odd", i)!;
		};
	};

	// Match expression
	const value: (int | void) = 42;
	match (value) {
	case let n: int =>
		fmt::printfln("Got integer: {}", n)!;
	case void =>
		fmt::println("Got void")!;
	};
};
