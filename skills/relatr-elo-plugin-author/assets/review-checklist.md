# Plugin review checklist

- Is the plugin focused on one scoring signal?
- Does every `do` appear as a full binding RHS in `plan` or `then`?
- Do capability args use the exact Relatr shape?
- Are nullable results handled with fallbacks?
- Are relay queries bounded with explicit `limit`?
- Does the final score logic stay in `[0.0, 1.0]`?
- Are manifest tags suitable for kind `765` publication?
