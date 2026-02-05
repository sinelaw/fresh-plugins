# Emmet Plugin for Fresh Editor

Emmet abbreviation expansion for HTML, CSS, JSX, and more - dramatically speed up your markup writing.

## Features

- **HTML/XML Expansion**: Quickly generate complex nested structures
- **CSS Abbreviations**: Fast property-value generation
- **Multi-file Support**: Works with HTML, CSS, JS, JSX, TSX, Vue, Svelte, and more
- **Smart Detection**: Auto-detects context (HTML vs CSS)
- **Standard Syntax**: Uses familiar Emmet abbreviation syntax

## Installation

### Via Package Manager

1. Open Fresh
2. Press `Ctrl+P` to open command palette
3. Search for `pkg: Install from URL`
4. Enter: `https://github.com/sinelaw/fresh-plugins#emmet`
5. Restart Fresh

### Manual Installation

```bash
cd ~/.config/fresh/plugins/packages
git clone https://github.com/sinelaw/fresh-plugins
ln -s fresh-plugins/emmet emmet
```

Then restart Fresh.

## Usage

### Method 1: Tab Key (Automatic!)

**The Tab key is automatically bound in HTML/CSS/SCSS files!**

1. Open an HTML, CSS, or SCSS file
2. Type an Emmet abbreviation (e.g., `div.container>ul>li*3`)
3. Press **Tab** to expand
4. If there's no abbreviation to expand, Tab inserts a normal tab character

### Method 2: Expand from Prompt

1. Open command palette (`Ctrl+P`)
2. Run `Emmet: Expand Abbreviation from Prompt`
3. Type your abbreviation (e.g., `ul>li*3`)
4. Press Enter to expand and insert

### Method 3: Expand in Buffer (Command Palette)

1. Type an Emmet abbreviation in your file
2. Open command palette (`Ctrl+P`)
3. Run `Emmet: Expand Abbreviation`

### Optional: Custom Keyboard Shortcuts

You can also add custom keybindings to your `~/.claude/keybindings.json`:

**Ctrl+E for prompt-based expansion:**
```json
{
  "key": "Ctrl+e",
  "command": "emmet_expand_from_prompt"
}
```

## Examples

### Basic HTML Tags

```
div → <div></div>
p → <p></p>
span → <span></span>
```

### Classes and IDs

```
div.container → <div class="container"></div>
p#intro → <p id="intro"></p>
.box → <div class="box"></div>
#header → <div id="header"></div>
```

### Multiple Classes

```
div.container.mx-auto.px-4 → <div class="container mx-auto px-4"></div>
```

### Attributes

```
a[href=https://example.com] → <a href="https://example.com"></a>
input[type=text][placeholder=Enter name] → <input type="text" placeholder="Enter name" />
```

### Nesting

```
div>p → <div>
          <p></p>
        </div>

ul>li → <ul>
          <li></li>
        </ul>

div>header>nav → <div>
                   <header>
                     <nav></nav>
                   </header>
                 </div>
```

### Siblings

```
div+p+span → <div></div>
             <p></p>
             <span></span>

h1+p → <h1></h1>
       <p></p>
```

### Multiplication

```
ul>li*3 → <ul>
            <li></li>
            <li></li>
            <li></li>
          </ul>

div.item*4 → <div class="item"></div>
             <div class="item"></div>
             <div class="item"></div>
             <div class="item"></div>
```

### Text Content

```
p{Hello World} → <p>Hello World</p>
a{Click me} → <a>Click me</a>
```

### Input Types

```
input:text → <input type="text" />
input:email → <input type="email" />
input:password → <input type="password" />
button:submit → <button type="submit"></button>
```

### Complex Examples

```
div.container>header.header>nav>ul>li.nav-item*3>a
→
<div class="container">
  <header class="header">
    <nav>
      <ul>
        <li class="nav-item">
          <a></a>
        </li>
        <li class="nav-item">
          <a></a>
        </li>
        <li class="nav-item">
          <a></a>
        </li>
      </ul>
    </nav>
  </header>
</div>

form>input:text+input:email+button:submit
→
<form>
  <input type="text" />
  <input type="email" />
  <button type="submit"></button>
</form>
```

## CSS Abbreviations

### Margin & Padding

```
m10 → margin: 10px;
m10-20 → margin: 10px 20px;
m10-20-30-40 → margin: 10px 20px 30px 40px;

p10 → padding: 10px;
p10-20 → padding: 10px 20px;
```

### Width & Height

```
w100 → width: 100px;
w100p → width: 100%;
w50rem → width: 50rem;

h100 → height: 100px;
h100p → height: 100%;
```

### Font Size

```
fz16 → font-size: 16px;
fz1.5rem → font-size: 1.5rem;
```

### Display

```
db → display: block;
di → display: inline;
dib → display: inline-block;
df → display: flex;
dg → display: grid;
dn → display: none;
```

### Position

```
posa → position: absolute;
posr → position: relative;
posf → position: fixed;
poss → position: sticky;
```

### Flexbox

```
jcc → justify-content: center;
jcsb → justify-content: space-between;
aic → align-items: center;
fdc → flex-direction: column;
```

### Colors

```
c#fff → color: #fff;
c#ff0000 → color: #ff0000;
bg#fff → background-color: #fff;
```

## Supported File Types

- HTML: `.html`, `.htm`, `.xml`
- CSS: `.css`, `.scss`, `.sass`, `.less`
- JavaScript: `.js`, `.jsx`
- TypeScript: `.ts`, `.tsx`
- Vue: `.vue`
- Svelte: `.svelte`

## Tips

1. **Start Simple**: Begin with basic abbreviations and gradually learn more complex syntax
2. **Chain Operations**: Combine multiple techniques (classes + nesting + multiplication)
3. **Context Aware**: The plugin detects whether you're in HTML or CSS context
4. **Fallback**: If expansion doesn't work, check the abbreviation syntax

## Limitations

This is a simplified Emmet implementation that covers the most common use cases. Some advanced features from the full Emmet library may not be supported:

- Item numbering with `$` is not yet implemented
- Advanced CSS gradient/shadow expansions
- Custom snippets

For the complete Emmet documentation, see: https://docs.emmet.io/

## Troubleshooting

**Abbreviation not expanding?**
- Ensure the file type is supported
- Check that the cursor is at the end of the abbreviation
- Verify the abbreviation syntax is correct
- Check Fresh's debug log for errors

**Tab key not working?**
- Ensure you've added the keybinding to `keybindings.json`
- Restart Fresh after changing keybindings

## Contributing

Found a bug or want to add a feature? Contributions welcome!

Repository: https://github.com/sinelaw/fresh-plugins

## License

MIT
