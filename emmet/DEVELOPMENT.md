# Emmet Plugin Development Guide

## Structure

```
emmet/
├── package.json              # Plugin manifest (bundle type)
├── README.md                 # User-facing documentation
├── LICENSE                   # MIT license
├── DEVELOPMENT.md           # This file
├── check-types.sh           # TypeScript type checker
├── emmet.i18n.json          # Internationalization strings
├── examples.html            # Example file for testing
└── plugins/
    ├── emmet.ts             # Main plugin implementation
    └── lib/
        └── fresh.d.ts       # Fresh Editor API types
```

## Architecture

### Core Components

1. **HTML Parser** (`parseEmmet`)
   - Tokenizes Emmet abbreviations
   - Builds an AST of EmmetNode structures
   - Supports nesting, siblings, multiplication, attributes

2. **HTML Renderer** (`renderHTML`)
   - Converts EmmetNode AST to formatted HTML
   - Handles indentation, self-closing tags, attributes

3. **CSS Parser** (`parseCSS`)
   - Recognizes CSS abbreviation patterns
   - Returns EmmetCSSRule structures

4. **CSS Renderer** (`renderCSS`)
   - Converts CSS rules to property:value format

5. **Context Detection** (`canExpandEmmet`, `getAbbreviationBeforeCursor`)
   - File type detection
   - Abbreviation extraction from buffer

6. **Expansion Logic** (`expandAbbreviation`)
   - Coordinates parsing, rendering, and text replacement
   - Handles both HTML and CSS contexts

### API Integration

- Uses `editor.getBufferText()` to read current line
- Uses `editor.deleteRange()` to remove abbreviation
- Uses `editor.insertAtCursor()` to insert expanded text
- Uses `editor.getCursorPosition()` and `editor.getCursorLine()` for positioning

## Supported Syntax

### HTML Abbreviations

- **Tags**: `div`, `p`, `span`
- **Classes**: `.class`, `div.class`
- **IDs**: `#id`, `div#id`
- **Attributes**: `a[href=url]`, `input[type=text][placeholder=Name]`
- **Nesting**: `div>p>span` (child operator)
- **Siblings**: `div+p+span` (sibling operator)
- **Multiplication**: `li*3`, `div.item*5`
- **Text Content**: `p{Hello}`, `a{Click me}`
- **Type Shortcuts**: `input:text`, `button:submit`
- **Grouping**: `(header>nav)+main+footer` (future enhancement)

### CSS Abbreviations

- **Margin**: `m10`, `m10-20-30-40`
- **Padding**: `p10`, `p10-20`
- **Width/Height**: `w100`, `w100p`, `h50rem`
- **Font Size**: `fz16`, `fz1.5rem`
- **Display**: `db`, `di`, `dib`, `df`, `dg`, `dn`
- **Position**: `posa`, `posr`, `posf`, `poss`
- **Flexbox**: `jcc`, `jcsb`, `aic`, `fdc`
- **Colors**: `c#fff`, `bg#ff0000`

## Testing

### Type Checking

```bash
./check-types.sh
```

Uses TypeScript compiler with ESNext target and DOM libs.

### Manual Testing

1. Install plugin in Fresh
2. Open `examples.html`
3. Test abbreviations listed in comments
4. Verify expansion in different file types (HTML, CSS, JSX, etc.)

### Test Cases

**Basic HTML**:
- `div` → `<div></div>`
- `p.intro` → `<p class="intro"></p>`
- `div#header` → `<div id="header"></div>`

**Nesting**:
- `ul>li*3` → nested list with 3 items
- `div>header>nav>ul>li` → deeply nested structure

**Siblings**:
- `div+p+span` → three sibling elements

**Attributes**:
- `a[href=#]` → `<a href="#"></a>`
- `input:email` → `<input type="email" />`

**CSS**:
- `m10` → `margin: 10px;`
- `df` → `display: flex;`
- `w100p` → `width: 100%;`

## Extending the Plugin

### Adding New CSS Abbreviations

Edit `parseCSS()` function:

```typescript
else if (abbr === "new-abbr") {
  rules.push({ property: "css-property", value: "value" });
}
```

### Adding New HTML Patterns

Modify `parseElement()` to handle new syntax patterns.

### Supporting New File Types

Add extensions to `canExpandEmmet()`:

```typescript
const supportedExts = [
  ".html", ".htm", ".xml",
  ".new-ext", // Add here
  // ...
];
```

## Known Limitations

1. **No Item Numbering**: `$` syntax not yet implemented
2. **No Advanced Grouping**: Complex `()` grouping has limited support
3. **No Custom Snippets**: No user-defined abbreviations yet
4. **Simple CSS**: Only common patterns, not full Emmet CSS syntax
5. **No Climb-up**: `^` operator not implemented

## Future Enhancements

- [ ] Item numbering with `$` (e.g., `li.item$*3` → item1, item2, item3)
- [ ] Lorem ipsum generation (`lorem10`)
- [ ] Custom snippet definitions
- [ ] More CSS abbreviations (gradients, shadows, transforms)
- [ ] Wrap with abbreviation command
- [ ] Balance inward/outward commands
- [ ] Configuration for formatting preferences

## Contributing

See main repository for contribution guidelines:
https://github.com/sinelaw/fresh-plugins

## Resources

- [Emmet Official Documentation](https://docs.emmet.io/)
- [Fresh Plugin API Docs](https://getfresh.dev/docs/plugins/)
- [Fresh Editor Repository](https://github.com/sinelaw/fresh)
