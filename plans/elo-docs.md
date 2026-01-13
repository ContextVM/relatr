Learn Elo

Elo is an expression language that compiles to JavaScript, Ruby, and SQL. Think of it as an extended calculator: you write expressions, Elo gives you results. Let's explore what makes Elo special.

1. Introduction

Here's a taste of what Elo can do. Don't worry if you don't understand everything yet— that's what the next chapters are for!

let
signup = D2024-01-15,
trial = P30D
in
TODAY > signup + trial

This checks if a 30-day trial has expired. Notice how naturally Elo handles dates and durations.

[10, 25, 5, 30] |> filter(x ~> x > 15) |> map(x ~> x \* 1.21)

This filters a list to keep values above 15, then applies VAT to each. Data flows left to right.

\_.email |> lower |> endsWith('@company.com')

This checks if an input email belongs to a company domain. The \_ is input data.

Write once, run anywhere: These expressions compile to JavaScript, Ruby, and SQL. The same logic works in your browser, on your server, or in your database. 2. Extended Arithmetics

You know how calculators work with numbers. Elo extends this idea to other types. The same operators (+, -, \*) work on different kinds of data.
Numbers

Just like a calculator:

2 + 3 \* 4

2 ^ 10

Booleans

True/false values with and, or, not:

5 > 3 and 10 <= 10

not (1 == 2) or false

Strings

Text with + for concatenation, \* for repetition:

'Hello, ' + 'World!'

'ho! ' \* 3

Dates & Durations

Dates start with D, durations with P (ISO 8601):

D2024-12-25

TODAY + P30D

NOW + PT2H30M

You can subtract dates to get durations, and scale durations:

D2024-12-31 - D2024-01-01

P1D \* 7

The pattern: Operators like +, -, \* are not just for numbers. Each type defines what these operations mean. See the stdlib for all type-specific operations.

Practice: Build a Greeting 3. Data Structures

Real data comes in structures: records with fields, collections of items. Elo has two main structures.
Tuples

Named fields, like a record or JSON object:

{ name: 'Alice', age: 30, city: 'Brussels' }

Access fields with a dot:

{ name: 'Alice', age: 30 }.name

Lists

Ordered collections in square brackets:

[1, 2, 3, 4, 5]

['apple', 'banana'] + ['cherry']

Get elements by position:

first([10, 20, 30])

at([10, 20, 30], 1)

Data Paths & Fetch

Navigate nested data safely with paths:

let data = { user: { name: 'Alice' } } in fetch(data, .user.name)

Paths start with a dot. fetch returns null if any part is missing:

let data = { user: null } in fetch(data, .user.name) | 'Unknown'

Think JSON: Tuples and lists work just like JSON objects and arrays. Elo makes them first-class citizens with operators and safe navigation.

Practice: Product Total 4. Functions

Operators are great, but sometimes you need more. Elo has a standard library of functions, and you can define your own.
Standard Library

Built-in functions for common operations:

upper('hello')

abs(-42)

year(TODAY)

length([1, 2, 3])

Lambdas

Define your own functions with fn:

let double = fn(x ~> x \* 2) in double(21)

let greet = fn(name ~> 'Hello, ' + name + '!') in greet('Elo')

Functions can take multiple parameters:

let add = fn(a, b ~> a + b) in add(3, 4)

Sugar Syntax

For single-parameter lambdas, you can skip fn():

map([1, 2, 3], x ~> x \* 2)

Functions are values: You can pass functions to other functions, store them in variables, and return them. This is key for list processing in Chapter 6. Explore all stdlib functions.

Practice: Text Transform 5. Program Structure

Complex expressions need structure. Elo provides three key constructs.
Let Bindings

Name intermediate values to avoid repetition:

let price = 100 in price \* 1.21

let width = 10, height = 5 in width \* height

Names don't change—once bound, a value stays the same. No surprises!
Conditionals

Choose between values with if/then/else:

if 5 > 3 then 'yes' else 'no'

let age = 25 in if age >= 18 then 'adult' else 'minor'

In Elo, if is an expression—it always produces a value.
Pipe Operator

Chain operations left-to-right with |>:

' hello ' |> trim |> upper

Compare with nested calls:

upper(trim(' hello '))

The pipe version reads naturally: take this, then do that, then that.

let double = fn(n ~> n \* 2) in '42' |> Int |> double

Assembly line: Data flows through the pipe, getting transformed at each step. Much cleaner than deeply nested parentheses!

Practice: Rectangle Area 6. Advanced Processing

Now we combine functions and lists for powerful data processing.
Map, Filter, Reduce

map transforms each element:

map([1, 2, 3], x ~> x \* 2)

filter keeps elements that match:

filter([1, 2, 3, 4, 5], x ~> x > 2)

reduce combines all elements into one value:

reduce([1, 2, 3, 4], 0, fn(sum, x ~> sum + x))

Chain them together:

[1, 2, 3, 4, 5] |> filter(x ~> x > 2) |> map(x ~> x \* 10)

Null Handling

Missing data is represented by null. The | operator provides fallbacks:

null | 'default'

indexOf('hello', 'x') | -1

Use isNull to check:

isNull(null)

Type Selectors

Parse and validate strings into typed values:

Int('42')

Date('2024-12-25')

Duration('P1D')

Strict validation: Type selectors throw an error if parsing fails. This ensures data integrity - invalid input like Int('abc') won't silently become null.

Practice: Filter and Double 7. Input Data

So far we've worked with literal values. Real programs process external data. In Elo, input is accessed through the special \_ variable.
The Input Variable

When you use \_, your expression becomes a function:

\_ \* 2

Access fields of input data:

_.price \* _.quantity

\_.name |> upper

Data Transformation

Elo expressions are data transformations: input flows in, result flows out.

\_.items |> map(x ~> x.price) |> reduce(0, fn(sum, p ~> sum + p))

if _.status == 'active' then _.budget \* 1.1 else \_.budget

Try It

In the playground, enter input data in the Input Data panel. You can switch between JSON and CSV formats using the dropdown. For example, with input {"price": 100, "quantity": 3}:

_.price \* _.quantity

Think transformations: Every Elo expression with \_ is a reusable transformation. The same expression works whether it runs in your browser (JS), server (Ruby), or database (SQL).

Learn more: See Data Formats in the Reference for details on JSON/CSV conversion and CLI usage.

Practice: Order Total 8. Data Validation

External data (JSON from APIs, user input) needs validation. Elo's type definitions let you define schemas that validate structure and coerce values to the right types.

Note: Type definitions compile to JavaScript and Ruby only. SQL is not supported.
Type Coercion

Type selectors like Int() parse strings. With type definitions, you define reusable types:

let T = Int in '42' |> T

Uppercase names create type definitions. Apply them with the pipe operator.
Struct Schemas

Define the expected shape of objects:

let Person = { name: String, age: Int } in
{ name: 'Alice', age: '30' } |> Person

This validates the structure and coerces age from string '30' to integer 30. Missing or extra fields cause an error.
Optional Fields

Mark fields as optional with :?:

let T = { name: String, age :? Int } in
{ name: 'Bob' } |> T

Missing optional fields are omitted from the result.
Arrays

Validate arrays where each element matches a type:

let Numbers = [Int] in ['1', '2', '3'] |> Numbers

Each string is coerced to an integer: [1, 2, 3].
Union Types

Accept multiple types with |:

let T = Int|String in 'hello' |> T

Tries each alternative left-to-right, returns the first match.

let T = [Int|String] in ['42', 'hello'] |> T

Returns [42, 'hello']—numeric strings become integers.
Constraints

Add validation predicates to types:

let Positive = Int(n | n > 0) in '42' |> Positive

The value is first coerced to Int, then the constraint n > 0 is checked.
Composing Types

Build complex schemas from simpler ones:

let
Age = Int(a | a >= 0),
Person = { name: String, age: Age }
in { name: 'Alice', age: '30' } |> Person

Named types can reference other named types for reusable schemas.

Think Finitio: Elo's type definitions are inspired by Finitio. They validate and transform external data in one step—perfect for API responses and user input.

Practice: Validate Data 9. Guards

Type definitions validate data structure. Guards go further—they validate conditions and make your assumptions explicit. Use guards to reason confidently about your code.

Note: Guards compile to JavaScript and Ruby only. SQL is not supported.
Simple Guards

A guard checks a condition before evaluating its body:

guard 10 > 0 in 10 \* 2

If the condition is false, an error is thrown. If true, the body is evaluated.
Labeled Guards

Add labels to make error messages meaningful:

guard positive: 5 > 0 in 5 \* 2

Labels can be identifiers or string messages:

guard 'value must be positive': 5 > 0 in 5 \* 2

Multiple Guards

Separate multiple conditions with commas:

guard
positive: _.age > 0,
adult: _.age >= 18
in
'Welcome!'

Each condition is checked in order. The first failure stops execution.
Guard with Let

Guards combine naturally with let bindings:

let x = 10 guard x > 0 in x \* 2

This is sugar for: let x = 10 in guard x > 0 in x \* 2
Check (Postconditions)

check is a synonym for guard, used idiomatically for postconditions:

let result = 5 \* 4 check result > 0 in result

Pipe-Style Guards

Use guards in pipelines with the predicate binding syntax:

10 |> guard(x | x > 0)

The value is bound to x, checked, and returned if valid. Chain with other operations:

let double = fn(n ~> n \* 2) in
10 |> guard(x | x > 0) |> double

Why guards matter: Guards make your assumptions visible. Instead of hoping data is valid, you state exactly what you expect. When something fails, the labeled error tells you exactly which assumption was violated.

Practice: Guard Input
Exercises

Practice what you've learned! Each exercise uses assert(condition) to check your answer. If the condition is true, the assertion passes. Replace the ??? placeholders with your code, then click "Check" to verify.
Build a Greeting
Chapter 2

Use string concatenation to build the greeting "Hello, World!".
assert(??? + ??? == 'Hello, World!')
Product Total
Chapter 3

Access the price and quantity fields from the tuple to compute the total (should be 100).
assert({ price: 25, quantity: 4 }.??? \* { price: 25, quantity: 4 }.??? == 100)
Text Transform
Chapter 4

Use stdlib functions to transform " hello " into "HELLO" (trim whitespace, then uppercase).
assert(???(???(' hello ')) == 'HELLO')
Rectangle Area
Chapter 5

Use let bindings to store width (8) and height (5), then compute the area.
let
width = ???,
height = ???
in
assert(width \* height == 40)
Filter and Double
Chapter 6

Keep only numbers greater than 10, then double each remaining value.
assert(([5, 12, 8, 20, 3, 15] |> filter(???) |> map(???)) == [24, 40, 30])
Order Total
Chapter 7

Given input data with price and quantity, compute the total.
let order = { price: 50, quantity: 3 } in
assert(order.??? \* order.??? == 150)
Validate Data
Chapter 8

Define a type that validates a product with a name (String) and price (Int), then apply it to coerce the price from a string.
let Product = { ???: ???, ???: ??? } in
assert({ name: 'Widget', price: '99' } |> Product == { name: 'Widget', price: 99 })
Guard Input
Chapter 9

Write a guard that checks the value is positive (greater than 0), then doubles it. The assertion should pass.
assert((guard ???: 5 > ??? in 5 \* 2) == 10)
Real-World Use Cases

Now that you've learned the fundamentals, let's see how Elo handles real-world scenarios. These examples demonstrate practical applications that combine multiple features you've learned.
Form Validation

APIs receive data that needs validation and normalization. This example validates a user registration payload, ensuring fields have the right types and constraints.

let
Email = String(e | contains(e, '@') and length(e) >= 5),
Age = Int(a | a >= 13 and a <= 120),
Username = String(u | length(u) >= 3 and length(u) <= 20),
Registration = {
username: Username,
email: Email,
age: Age,
newsletter :? Bool
}
in
{
username: 'alice',
email: 'alice@example.com',
age: '25',
newsletter: 'true'
} |> Registration

The type definition validates structure, coerces age from string to integer, parses newsletter as boolean, and enforces constraints on each field. If any validation fails, an error is thrown immediately.

Note: Type definitions compile to JavaScript and Ruby only.
Order Processing

E-commerce systems process orders to calculate totals with discounts. This example shows how to transform order data using pipes and list operations.

let
order = {
items: [
{ name: 'Widget', price: 25, quantity: 2 },
{ name: 'Gadget', price: 50, quantity: 1 },
{ name: 'Thing', price: 10, quantity: 5 }
],
discountPercent: 10
},
subtotal = (order.items
|> map(i ~> i.price _ i.quantity)
|> reduce(0, fn(sum, x ~> sum + x))),
discount = subtotal _ order.discountPercent / 100,
total = subtotal - discount
in
{ subtotal: subtotal, discount: discount, total: total }

Data flows naturally through the pipeline: compute line totals, sum them, apply discount, return result. The same expression runs in the browser (JS), server (Ruby), or as part of a larger SQL query.
Subscription Logic

SaaS applications need to check subscription status, trial periods, and renewal dates. Elo's date arithmetic makes this business logic clear and portable.

let
subscription = {
plan: 'pro',
startDate: D2024-01-15,
trialDays: 30,
billingCycle: P30D
},
trialEnd = subscription.startDate + P1D \* subscription.trialDays,
isTrialActive = TODAY <= trialEnd,
nextBilling = if isTrialActive
then trialEnd
else subscription.startDate + subscription.billingCycle,
daysUntilBilling = if nextBilling > TODAY
then (nextBilling - TODAY) / P1D
else 0
in
{
isTrialActive: isTrialActive,
trialEnd: trialEnd,
nextBilling: nextBilling,
daysUntilBilling: daysUntilBilling
}

Date operations like +, -, and comparisons work naturally. Durations can be scaled and divided. The logic remains readable regardless of which runtime executes it.

Write once, run anywhere: This same subscription logic works in browser validation (JS), server-side processing (Ruby), or database queries (SQL).

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

npm install -g @enspirit/elo

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

npm install @enspirit/elo

compile()

Every Elo expression compiles to a function that takes \_ (the implicit input) as parameter.

import { compile } from '@enspirit/elo';
import { DateTime, Duration } from 'luxon';

const double = compile('\_ \* 2', { runtime: { DateTime, Duration } });
double(21); // => 42

Lower-Level API

import { parse, compileToJavaScript, compileToRuby, compileToSQL } from '@enspirit/elo';

const ast = parse('2 + 3 _ 4');
compileToJavaScript(ast); // => "2 + 3 _ 4"
compileToRuby(ast); // => "2 + 3 _ 4"
compileToSQL(ast); // => "2 + 3 _ 4"

Command Line

Elo provides two CLI tools: eloc (compiler) and elo (evaluator).
Evaluator (elo)

Quickly evaluate Elo expressions:

# Evaluate an expression

elo -e "2 + 3 \* 4" # => 14

# Evaluate with input data

elo -e "_.x + _.y" -d '{"x": 1, "y": 2}' # => 3

# Evaluate from file

elo expressions.elo

Option Description
-e, --expression Expression to evaluate
-d, --data JSON input data for \_
--stdin Read JSON input from stdin
Compiler (eloc)

Compile Elo to other languages:

# Compile to JavaScript (default)

eloc -e "2 + 3 \* 4"

# Compile to Ruby

eloc -e "2 + 3 \* 4" -t ruby

# Compile to SQL

eloc -e "2 + 3 \* 4" -t sql

# Include runtime prelude

eloc -e "NOW + PT2H" -t ruby -p

Option Description
-e, --expression Expression to compile
-t, --target Target: js, ruby, sql
-p, --prelude Include runtime imports
--strip-guards Remove guard/check assertions
-f, --file Output to file

Order Processing

E-commerce systems process orders to calculate totals with discounts. This example shows how to transform order data using pipes and list operations.

let
order = {
items: [
{ name: 'Widget', price: 25, quantity: 2 },
{ name: 'Gadget', price: 50, quantity: 1 },
{ name: 'Thing', price: 10, quantity: 5 }
],
discountPercent: 10
},
subtotal = (order.items
|> map(i ~> i.price _ i.quantity)
|> reduce(0, fn(sum, x ~> sum + x))),
discount = subtotal _ order.discountPercent / 100,
total = subtotal - discount
in
{ subtotal: subtotal, discount: discount, total: total }

Data flows naturally through the pipeline: compute line totals, sum them, apply discount, return result. The same expression runs in the browser (JS), server (Ruby), or as part of a larger SQL query.
Subscription Logic

SaaS applications need to check subscription status, trial periods, and renewal dates. Elo's date arithmetic makes this business logic clear and portable.

let
subscription = {
plan: 'pro',
startDate: D2024-01-15,
trialDays: 30,
billingCycle: P30D
},
trialEnd = subscription.startDate + P1D \* subscription.trialDays,
isTrialActive = TODAY <= trialEnd,
nextBilling = if isTrialActive
then trialEnd
else subscription.startDate + subscription.billingCycle,
daysUntilBilling = if nextBilling > TODAY
then (nextBilling - TODAY) / P1D
else 0
in
{
isTrialActive: isTrialActive,
trialEnd: trialEnd,
nextBilling: nextBilling,
daysUntilBilling: daysUntilBilling
}

Date operations like +, -, and comparisons work naturally. Durations can be scaled and divided. The logic remains readable regardless of which runtime executes it.

Standard Library

Built-in functions available in Elo. Click any function to try it in the playground.
Type Selectors

Type selectors validate and parse strings to typed values. They throw an error on invalid input.

Type selectors can be combined into data schemas for validating complex data structures like let Person = { name: String, age: Int } in data |> Person. JS/Ruby only.
Int
(value: String | Int | Float) → Int

Parses a string to an integer. Throws on invalid input.
Int('123')
→ 123
Float
(value: String | Int | Float) → Float

Parses a string to a float. Throws on invalid input.
Float('3.14')
→ 3.14
Bool
(value: String | Bool) → Bool

Parses 'true' or 'false' strings to boolean. Throws on invalid input.
Bool('true')
→ true
Null
(value: Null) → Null

Validates that a value is null. Throws on non-null input.
let T = Int|Null in null |> T
→ null
Date
(value: String | Date) → Date

Parses an ISO date string (YYYY-MM-DD) to a Date. Throws on invalid input.
Date('2025-01-15')
→ D2025-01-15
Datetime
(value: String | DateTime) → DateTime

Parses an ISO datetime string to a DateTime. Throws on invalid input.
Datetime('2025-01-15T10:30:00')
→ D2025-01-15T10:30:00
Duration
(value: String | Duration) → Duration

Parses an ISO 8601 duration string. Throws on invalid input.
Duration('P1D')
→ P1D
Data
(value: String | Any) → List | Tuple

Parses a JSON string. Non-strings are returned as-is. Throws on invalid JSON.
Data('{"name": "Alice"}')
→ {name: 'Alice'}
Any

Functions that work on any type.
typeOf
(value: Any) → String

Returns the type name of the value.
typeOf(42)
→ 'Int'
isNull
(value: Any) → Bool

Returns true if the value is null.
isNull(null)
→ true
Date

Operators and functions for dates.

- (Date, Duration) → Date

Adds a duration to a date.
D2024-01-15 + P7D
→ D2024-01-22

- (Date, Duration) → Date

Subtracts a duration from a date.
D2024-01-15 - P7D
→ D2024-01-08

- (Date, Date) → Duration

Returns the duration between two dates.
D2024-01-15 - D2024-01-01
→ P14D
year
(d: Date) → Int

Extracts the year from a date.
year(D2024-06-15)
→ 2024
month
(d: Date) → Int

Extracts the month (1-12) from a date.
month(D2024-06-15)
→ 6
day
(d: Date) → Int

Extracts the day of month (1-31).
day(D2024-06-15)
→ 15
DateTime

Operators and functions for datetimes. Date functions (year, month, day) also work on DateTime.

- (DateTime, Duration) → DateTime

Adds a duration to a datetime.
D2024-01-15T10:00:00Z + PT2H
→ D2024-01-15T12:00:00Z

- (DateTime, Duration) → DateTime

Subtracts a duration from a datetime.
D2024-01-15T10:00:00Z - PT2H
→ D2024-01-15T08:00:00Z
hour
(dt: DateTime) → Int

Extracts the hour (0-23) from a datetime.
hour(D2024-06-15T14:30:00Z)
→ 14
minute
(dt: DateTime) → Int

Extracts the minute (0-59) from a datetime.
minute(D2024-06-15T14:30:00Z)
→ 30
Duration

Operators and functions for ISO 8601 durations.

- (Duration, Duration) → Duration

Adds two durations together.
P1D + PT12H
→ P1DT12H

- (Duration, Int | Float) → Duration

Scales a duration by a factor.
P1D \* 2
→ P2D
/
(Duration, Int | Float) → Duration

Divides a duration by a factor.
P10D / 2
→ P5D
List

Operators and functions for working with lists.

- (List, List) → List

Concatenates two lists.
[1, 2] + [3, 4]
→ [1, 2, 3, 4]
all
(list: List, predicate: Function) → Bool

Returns true if all elements satisfy predicate. JS/Ruby only.
all([1, 2, 3], fn(x ~> x > 0))
→ true
any
(list: List, predicate: Function) → Bool

Returns true if any element satisfies predicate. JS/Ruby only.
any([1, 2, 3], fn(x ~> x > 2))
→ true
at
(list: List, index: Int) → Any

Returns the element at the given index (0-based).
at([1, 2, 3], 1)
→ 2
filter
(list: List, predicate: Function) → List

Returns elements where predicate returns true. JS/Ruby only.
filter([1, 2, 3, 4], fn(x ~> x > 2))
→ [3, 4]
first
(list: List) → Any

Returns the first element of the list.
first([1, 2, 3])
→ 1
isEmpty
(list: List) → Bool

Returns true if the list is empty.
isEmpty([])
→ true
join
(list: List, sep: String) → String

Joins list elements into a string using the separator.
join(['a', 'b', 'c'], ',')
→ 'a,b,c'
last
(list: List) → Any

Returns the last element of the list.
last([1, 2, 3])
→ 3
length
(list: List) → Int

Returns the number of elements in the list.
length([1, 2, 3])
→ 3
map
(list: List, fn: Function) → List

Returns a new list with fn applied to each element. JS/Ruby only.
map([1, 2, 3], fn(x ~> x \* 2))
→ [2, 4, 6]
reduce
(list: List, initial: Any, fn: Function) → Any

Reduces the list to a single value. JS/Ruby only.
reduce([1, 2, 3], 0, fn(acc, x ~> acc + x))
→ 6
reverse
(list: List) → List

Returns a new list with elements in reverse order.
reverse([1, 2, 3])
→ [3, 2, 1]
Numeric

Operators and functions for numeric operations (Int and Float).

- (Int | Float, Int | Float) → Int | Float

Adds two numbers.
2 + 3
→ 5

- (Int | Float, Int | Float) → Int | Float

Subtracts two numbers.
10 - 4
→ 6

- (Int | Float, Int | Float) → Int | Float

Multiplies two numbers.
3 \* 4
→ 12
/
(Int | Float, Int | Float) → Float

Divides two numbers.
10 / 4
→ 2.5
%
(Int | Float, Int | Float) → Int | Float

Returns the remainder after division.
10 % 3
→ 1
^
(Int | Float, Int | Float) → Int | Float

Raises a number to a power.
2 ^ 10
→ 1024
abs
(n: Int | Float) → Int | Float

Returns the absolute value of a number.
abs(-5)
→ 5
ceil
(n: Float) → Int

Rounds a number up to the nearest integer.
ceil(3.2)
→ 4
floor
(n: Float) → Int

Rounds a number down to the nearest integer.
floor(3.9)
→ 3
round
(n: Float) → Int

Rounds a number to the nearest integer.
round(3.7)
→ 4
String

Operators and functions for string manipulation.

- (String, String) → String

Concatenates two strings.
'hello' + ' world'
→ 'hello world'

- (String, Int) → String

Repeats a string n times.
'hi' \* 3
→ 'hihihi'
concat
(a: String, b: String) → String

Concatenates two strings. Same as +.
concat('hello', ' world')
→ 'hello world'
contains
(s: String, sub: String) → Bool

Returns true if the string contains the given substring.
contains('hello', 'ell')
→ true
endsWith
(s: String, suffix: String) → Bool

Returns true if the string ends with the given suffix.
endsWith('hello', 'lo')
→ true
indexOf
(s: String, sub: String) → Int | Null

Returns the index of the first occurrence, or null if not found.
indexOf('hello', 'l')
→ 2
isEmpty
(s: String) → Bool

Returns true if the string is empty.
isEmpty('')
→ true
length
(s: String) → Int

Returns the number of characters in the string.
length('hello')
→ 5
lower
(s: String) → String

Converts all characters to lowercase.
lower('HELLO')
→ 'hello'
padEnd
(s: String, len: Int, pad: String) → String

Pads the end of the string to reach the target length.
padEnd('hi', 5, '.')
→ 'hi...'
padStart
(s: String, len: Int, pad: String) → String

Pads the start of the string to reach the target length.
padStart('42', 5, '0')
→ '00042'
replace
(s: String, search: String, repl: String) → String

Replaces the first occurrence of search with repl.
replace('abab', 'ab', 'x')
→ 'xab'
replaceAll
(s: String, search: String, repl: String) → String

Replaces all occurrences of search with repl.
replaceAll('abab', 'ab', 'x')
→ 'xx'
split
(s: String, sep: String) → List

Splits the string into a list using the separator.
split('a,b,c', ',')
→ ['a', 'b', 'c']
startsWith
(s: String, prefix: String) → Bool

Returns true if the string starts with the given prefix.
startsWith('hello', 'he')
→ true
substring
(s: String, start: Int, len: Int) → String

Extracts a substring starting at start (0-indexed) with length len.
substring('hello', 1, 3)
→ 'ell'
trim
(s: String) → String

Removes leading and trailing whitespace.
trim(' hi ')
→ 'hi'
upper
(s: String) → String

Converts all characters to uppercase.
upper('hello')
→ 'HELLO'
Tuple (Data)

Functions for working with data structures (tuples and nested objects).
deepMerge
(a: Any, b: Any) → Any

Recursively merges two objects. Nested objects are merged; other values from b override a.
deepMerge({x: {a: 1}}, {x: {b: 2}})
→ {x: {a: 1, b: 2}}
fetch
(data: Any, path: DataPath) → Any | Null
(data: Any, paths: Tuple) → Tuple
(data: Any, paths: List) → List

Navigates the data structure following the path. Returns null if any segment fails. Can fetch multiple paths into a tuple or list.
fetch({name: 'Alice'}, .name)
→ 'Alice'
fetch({a: 1, b: 2}, {x: .a, y: .b})
→ {x: 1, y: 2}
fetch({a: 1, b: 2}, [.a, .b])
→ [1, 2]
merge
(a: Any, b: Any) → Any

Shallow merges two objects. Properties from b override properties from a.
merge({a: 1}, {b: 2})
→ {a: 1, b: 2}
patch
(data: Any, path: DataPath, value: Any) → Any

Returns a new tuple with the value patched at the given path. Creates intermediate structures as needed.
patch({}, .user.name, 'Bob')
→ {user: {name: 'Bob'}}
