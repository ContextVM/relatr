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
