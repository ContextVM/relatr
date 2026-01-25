The Elo Language

Elo is a small expression language that compiles to JavaScript, Ruby, and SQL. Write once, run anywhere.
Types

Elo has a simple type system with the following types. Use typeOf() to inspect types at runtime.
Type Description Examples
Int Integer numbers 42, -7, 0
Float Floating-point numbers 3.14, -0.5
Bool Boolean values true, false
String Text strings 'hello', 'world'
DateTime Dates and timestamps D2024-01-15, NOW, TODAY
Duration Time periods P1D, PT2H30M, P1Y2M
Tuple Key-value tuples {name: 'Alice', age: 30}
List Ordered collections [1, 2, 3], ['a', 'b']
Function Lambda functions fn( x ~> x \* 2 )
Null Null values null

Note: Use null for absent values. Use isNull() to check for null, and the | operator to provide defaults: x | 'default'.
Type Introspection

typeOf(42) == 'Int' and typeOf(P1D) == 'Duration'

Use typeOf() to get the type name as a string.
Literals

Elo supports numbers, booleans, strings, dates, and durations as first-class values.
Numbers
Integers & Floats

42 + 3.14

Numbers include integers and floating-point values.
Booleans
Boolean Literals

true and not false

true and false are boolean literals.
Strings
String Literal

'hello world'

Strings use single quotes. Escape with backslash: 'it\'s working'.
Dates & Times
Date Literal

D2025-12-25

ISO date format with D prefix.
Temporal Keywords

TODAY < NOW

NOW is the current timestamp, TODAY is midnight today.
Period Boundaries

SOY <= TODAY and TODAY <= EOY

Start/End of Year (SOY/EOY), Quarter (SOQ/EOQ), Month (SOM/EOM), Week (SOW/EOW).
Time Boundaries

TODAY in BOT ... EOT

Beginning of Time (BOT) and End of Time (EOT) for open-ended ranges.
Durations
Duration Literal

P1Y2M3D

1 year, 2 months, 3 days. Use P prefix (ISO 8601).
Time Durations

PT2H30M

2 hours and 30 minutes. Use PT for time-only durations.
Data Paths
Path Literal

.user.address.city

Shorthand for ['user', 'address', 'city']. See Data Paths.
Type Selectors

Literal syntax (like 42 or 'hello') is shorthand for type selectors. Type selectors validate and convert values to specific types. They throw an error if parsing fails.
Parse String to Integer

Int('123')

Parses the string to the integer 123.
Convert to String

String(42) + ' items'

Converts a value to its string representation.
Parse Date

Date('2024-12-25')

Parses ISO 8601 date string to a date value.
Parse JSON

Data('{"name": "Alice"}').name

Parses a JSON string and accesses a property.

Available: Int(), Float(), Bool(), String(), Null(), Date(), Datetime(), Duration(), Data().

Note: Type selectors can be combined into Data Schemas for validating complex data structures.
Operators

Elo provides arithmetic, comparison, and logical operators.
Arithmetic
Basic Operations

(10 + 5) \* 2 - 8 / 4

Addition +, subtraction -, multiplication \*, division /.
Power & Modulo

2 ^ 10 + 17 % 5

Power ^ and remainder % operators.
Date Arithmetic

TODAY + P7D

Add durations to dates. Subtract with -.
Comparison
Comparison Operators

10 > 5 and 3 <= 3

Use >, <, >=, <=, ==, !=.
Logical
Logical Operators

(5 > 3 and 2 < 4) or not (1 == 2)

Combine conditions with and, or, and not.
Pipe Operator
Function Chaining

' hello world ' |> trim |> upper

The pipe operator |> passes the left value as the first argument to the right function.
Pipe with Arguments

'42' |> padStart(5, '0')

Additional arguments follow the piped value.
Alternative Operator
Fallback Chain

indexOf('hello', 'x') | indexOf('hello', 'l') | -1

The | operator returns the first non-null value.
Tuples

Elo tuples are collections of named values. They use JSON-like syntax with key-value pairs and compile to native structures in each target language.
Simple Tuple

{name: 'Alice', age: 30}

Create a tuple with named attributes.
Attribute Access

{budget: 1500}.budget

Access attributes with dot notation.
Tuple with Let

let t = {x: 10, y: 20} in t.x + t.y

Bind a tuple to a variable and access its attributes.

Note: Tuples look like JavaScript objects but Elo uses relational terminology. In SQL, they compile to PostgreSQL JSONB using jsonb_build_object().
Lists

Elo lists are ordered sequences using JSON-like array syntax. Lists are heterogeneous and compile to native arrays.
Simple List

[1, 2, 3]

Create a list with integer elements.
Mixed Types

[1, 'two', true, null]

Lists can mix different types including null.
Nested Lists

[[1, 2], [3, 4]]

Lists can contain other lists.

Note: Lists look like JavaScript arrays but Elo uses relational terminology. In SQL, they compile to PostgreSQL ARRAY[...] syntax.
Lambdas

Elo provides anonymous functions using lambdas:

    Lambdas: fn( params ~> body ) or x ~> body (sugar)

Lambda Expressions
Simple Lambda

fn( x ~> x \* 2 )

A function that doubles its input.
Multiple Parameters

fn( x, y ~> x + y )

Lambdas can take multiple parameters.
Sugar Syntax

[1, 2, 3] |> map(x ~> x \* 2)

Single-param lambdas can omit fn(). Returns [2, 4, 6].
Invoking Lambdas
Call a Lambda

let double = fn( x ~> x \* 2 ) in double(5)

Bind a lambda to a name, then call it. Returns 10.

Note: Lambdas compile to JavaScript and Ruby only. SQL does not support function expressions.
Local Variables

Use let ... in expressions to bind local variables.
Simple Binding

let x = 10 in x \* 2

Bind a value to a name, then use it in an expression.
Multiple Bindings

let width = 5, height = 3 in width \* height

Bind multiple variables separated by commas.
Conditionals

Use if ... then ... else expressions to branch based on conditions.
Simple Conditional

if 5 > 3 then 'yes' else 'no'

Returns 'yes' if the condition is true, 'no' otherwise.
Conditional with Let

let x = 10 in if x > 5 then 'big' else 'small'

Combine conditionals with local variables.
Range Membership

Check if a value falls within a range using the in operator.
Inclusive Range

5 in 1..10

True if 5 >= 1 AND 5 <= 10. Both ends are included.
Exclusive End Range

5 in 1...10

True if 5 >= 1 AND 5 < 10. End is excluded.
Date Range Check

TODAY in SOY..EOY

Check if today is within the current year.
Data Selector

The Data() selector parses JSON strings into Elo values. This is useful when receiving data as text from external sources.
Parse JSON Object

Data('{"name": "Alice", "age": 30}')

Parses a JSON string into a tuple with name and age attributes.
Parse JSON Array

Data('[1, 2, 3]')

Parses a JSON string into a list.
Access Parsed Data

Data('{"user": {"name": "Bob"}}').user.name

Parse and immediately access nested properties.

Note: See Type Selectors for all available selectors. For validating and transforming complex JSON structures, see Data Schemas.
Input Data

Every Elo program has access to external input via the special _ variable. When an expression uses _, the compiled output becomes a function that takes input data as a parameter.
Simple Input

\_ \* 2

Doubles the input value.
Tuple Input

_.price \* _.quantity

Access attributes of an input tuple.
Input with Transformation

\_.budget \* 1.21

Apply VAT to a budget value from input.

Note: When using the CLI, use elo with JSON input: elo -e "_.x + _.y" -d '{"x": 1, "y": 2}'
Data Paths

Data paths are syntactic sugar for lists of strings and integers. They provide a concise way to describe locations within nested data structures.
Simple Path

.name

Equivalent to ['name'].
Nested Path

.user.address.city

Equivalent to ['user', 'address', 'city'].
Path with Index

.items.0.name

Equivalent to ['items', 0, 'name']. Integers access list elements.
Navigating Data

Use fetch() to retrieve values and patch() to update them immutably.
Fetch Value

fetch({user: {name: 'Alice'}}, .user.name)

Returns 'Alice'. Returns null if path doesn't exist.
Fetch Multiple (Tuple)

fetch({a: 1, b: 2}, {x: .a, y: .b})

Fetch multiple paths into a tuple. Returns {x: 1, y: 2}.
Fetch Multiple (List)

fetch({a: 1, b: 2}, [.a, .b])

Fetch multiple paths into a list. Returns [1, 2].
Patch Value

patch({user: {name: 'Alice'}}, .user.name, 'Bob')

Returns a new tuple with the value updated at the path.

Note: Since data paths are lists, typeOf(.name) returns 'List'. The stdlib uses "DataPath" as a conceptual name in function signatures.
Data Schemas

Data schemas let you validate and transform complex data structures like JSON. Define schemas using uppercase let bindings with type selectors, then apply them with the pipe operator.

Note: Data schemas compile to JavaScript and Ruby only. SQL is not supported.
Basic Types

All type selectors can be used as schema types: Int, Float, Bool, String, Null, Date, Datetime, Duration, Data. Use . (dot) for any value.
Type Coercion

let T = Int in '42' |> T

Coerces the string '42' to integer 42.
Any Type

let T = . in 'anything' |> T

The dot . accepts any value unchanged.
Tuple Types
Simple Tuple

let Person = { name: String, age: Int } in
{ name: 'Alice', age: '30' } |> Person

Validates shape and coerces age from string to integer.
Optional Attributes

let T = { name: String, age :? Int } in
{ name: 'Bob' } |> T

Optional attributes (with :?) can be missing. Missing fields are omitted from result.
Open Tuple

let T = { name: String, ... } in
{ name: 'Eve', extra: 42 } |> T

Open tuples (...) allow extra attributes. They're ignored in output.
Array Types
Array of Integers

let Numbers = [Int] in ['1', '2', '3'] |> Numbers

Coerces each element. Returns [1, 2, 3].
Array of Tuples

let People = [{ name: String }] in
[{ name: 'A' }, { name: 'B' }] |> People

Validates each element against the tuple type.
Union Types
Union Type

let T = Int|String in 'hello' |> T

Tries alternatives left-to-right. Returns first successful match.
Mixed Array

let T = [Int|String] in ['42', 'hello'] |> T

Returns [42, 'hello'] - numeric strings become integers.
Subtype Constraints
Positive Integer

let Positive = Int(i | i > 0) in '42' |> Positive

Adds a predicate constraint. Throws if value is not positive.
Constrained Tuple

let Adult = { age: Int(a | a >= 18) } in
{ age: '25' } |> Adult

Constraints compose with tuple types.
Labeled Constraints

let PosEven = Int(i | positive: i > 0, even: i % 2 == 0) in
'42' |> PosEven

Multiple labeled constraints (Finitio-style). Label becomes error message.
String Messages

let Adult = Int(a | 'must be 18 or older': a >= 18) in
'25' |> Adult

Use string labels for human-readable error messages.
Named Type Aliases
Reusable Types

let
Age = Int(a | a >= 0),
Person = { name: String, age: Age }
in { name: 'Alice', age: '30' } |> Person

Define multiple types and reference them by name.
Data Formats

The CLI and playground support multiple input and output formats. Input data is parsed and made available as the \_ variable. Results can be formatted for different use cases.
JSON Format

JSON is the default format. Values map directly to Elo types:
JSON Elo Type Example
number Int or Float 42, 3.14
string String "hello"
boolean Bool true, false
null Null null
object Tuple {"name": "Alice"}
array List [1, 2, 3]
JSON Input

upper(_.name) + ' is ' + String(_.age)

Access fields from a JSON object.
CSV Format

CSV input is parsed as a list of tuples. The first row provides field names (headers), and subsequent rows become tuple values. All values are strings.
CSV Input:

name,age
Alice,30
Bob,25

→
Elo Value (\_):

[
{name: 'Alice', age: '30'},
{name: 'Bob', age: '25'}
]

Since CSV values are strings, you can convert them manually:
Manual Conversion

\_ |> map(r ~> {name: r.name, age: Int(r.age)})

Convert age strings to integers field by field.

Better approach: Use data schemas to declare a schema. This validates structure and converts types in one step:
Schema Conversion

let Person = {name: String, age: Int}
in \_ |> map(p ~> p |> Person)

Define a schema once, apply it to each row.
Output Formats

Results can be formatted as:

    JSON — Standard JSON serialization (default)
    Elo — Elo code syntax (readable, can be copy-pasted)
    CSV — For lists of tuples (spreadsheet-compatible)

CLI Usage

# JSON input (default)

elo -e "_.x + _.y" -d '{"x": 1, "y": 2}'

# CSV input from file (format auto-detected from .csv extension)

elo -e "map(\_, r ~> r.name)" -d @data.csv

# Explicit CSV format

elo -e "map(\_, r ~> r.name)" -d @data.txt -f csv

# Output as CSV

elo -e "[{a: 1}, {a: 2}]" -o csv

# Output as Elo code

elo -e "{name: 'test'}" -o elo

Custom Format Adapters

The format system is pluggable. You can provide custom adapters for formats like XLSX using libraries such as PapaParse or SheetJS. See the FormatAdapter interface in src/formats.ts.
Assertions

Use assert() to validate conditions at runtime.
Simple Assert

assert(2 + 2 == 4)

Throws an error if the condition is false.
Fail with Message

indexOf('hello', 'x') | fail('character not found')

Use fail(message) to throw an error with a custom message.
Guards

Guards validate conditions before returning a value. Use guard for preconditions and check for postconditions.
Simple Guard

guard 5 > 0 in 5 \* 2

Throws if condition is false, returns the body otherwise.
Labeled Guard

guard positive: 10 > 0 in 10

Labels become part of the error message on failure.
Multiple Guards

guard 10 > 0, 10 < 100 in 10

Separate multiple constraints with commas.
Let with Guard
Guard in Let Binding

let x = 5 guard x > 0 in x \* 2

Sugar syntax: bind a value, then guard on it.
Check (Postcondition)

let x = 10 check x > 0 in x + 5

check is a synonym for guard, used for postconditions.
Pipe-Style Guards
Guard in Pipeline

5 |> guard(x | x > 0)

Creates a lambda that validates its input. Returns the value if valid.

Note: Guards compile to JavaScript and Ruby only. Use --strip-guards to remove guards in production builds.
Get Started

Ready to use Elo on your computer? Here's how to get started.
Try Online First

The easiest way to explore Elo is the online playground — no installation needed.
Install the CLI

To run Elo locally, install the command-line tools via npm:

npm install -g @contextvm/elo

This gives you two commands:

    elo — Evaluate Elo expressions and see results immediately
    eloc — Compile Elo to JavaScript, Ruby, or SQL

Quick Examples

# Evaluate an expression

elo -e "2 + 3 \* 4" # => 14

# Evaluate from a file

echo "upper('hello')" > hello.elo
elo hello.elo # => HELLO

# Compile to JavaScript

eloc -e "2 + 3" # => (function(\_) { return 2 + 3; })

What's Next?

    Learning Elo? Start with the Learn tutorial
    Building an app? See the JavaScript API below
    Need a function? Browse the Standard Library

JavaScript API

For Node.js or browser projects, install the library:

npm install @contextvm/elo

compile()

Every Elo expression compiles to a function that takes \_ (the implicit input) as parameter.

import { compile } from '@contextvm/elo';
import { DateTime, Duration } from 'luxon';

const double = compile('\_ \* 2', { runtime: { DateTime, Duration } });
double(21); // => 42

Lower-Level API

import { parse, compileToJavaScript, compileToRuby, compileToSQL } from '@contextvm/elo';

const ast = parse('2 + 3 _ 4');
compileToJavaScript(ast); // => "2 + 3 _ 4"
compileToRuby(ast); // => "2 + 3 _ 4"
compileToSQL(ast); // => "2 + 3 _ 4"
