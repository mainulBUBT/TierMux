# 🚨 How to See the New UI in Development

The AI Elements UI changes **are built and ready** but you need to properly load the development version to see them.

## ✅ **Current Build Status**
- **TypeScript**: ✅ Compiled successfully
- **CSS**: ✅ All new stylesheets created and loaded
- **JavaScript**: ✅ New class names present in built code
- **Watch mode**: ✅ Running (rebuilds on file changes)

## 🔧 **How to See the New UI**

### **Option 1: Reload the Extension (Recommended)**
1. **Open VS Code Command Palette**: `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. **Type**: `Developer: Reload Window`
3. **Select it and press Enter**

This will reload VS Code with your newly built extension.

### **Option 2: Restart Extension Host**
1. **Open VS Code Command Palette**: `Cmd+Shift+P`
2. **Type**: `Developer: Restart Extension Host`
3. **Select it and press Enter`

This restarts just the extension without reloading the entire window.

### **Option 3: Manual Extension Reload**
1. Go to **Extensions** view (sidebar icon with puzzle piece)
2. Find **TierMux** extension
3. **Click the gear icon** → **Reload** or **Disable then Enable**

### **Option 4: Full VS Code Restart**
1. Completely quit VS Code
2. Reopen VS Code
3. Open your project

## 🎯 **What You Should See After Reload**

### **1. Enhanced Tool Cards**
- **Progress bars** for running tools (animated blue bars)
- **State labels**: "Running", "Completed", "Error" text
- **Better structure**: Clickable headers with icons
- **Expandable**: Click to see tool output

### **2. Enhanced Reasoning Blocks**
- **Streaming indicators**: Animated dots ●●● while thinking
- **Better collapsible**: Smooth animations
- **Status labels**: "Thinking" while working, "Thought" when complete

### **3. Proper Message Flow**
```
User Message
├─ 🧠 Reasoning (animated while thinking)
├─ 🔍 Tool Cards (with progress bars while running)
└─ 📝 Final Response
```

## 🔍 **Debugging If Still Not Working**

### **Check Console**
1. Open the TierMux chat panel
2. Right-click → **Inspect** or **Developer Tools**
3. Check **Console** tab for errors
4. Check **Network** tab for CSS loading issues

### **Check CSS Loading**
In the webview Developer Tools:
1. Go to **Sources** tab
2. Look for CSS files:
   - `styles/ai-elements-tokens.css`
   - `styles/components/tool-card.css`
   - `styles/components/reasoning.css`
   - etc.
3. All should be loaded (no 404 errors)

### **Verify JavaScript**
In the console, type:
```javascript
document.querySelector('.tm-tool-card')
```
This should find the first tool card element.

## 📁 **What Files Were Changed**

### **Core Files**
- `media/src/main.ts` - Updated UI rendering logic
- `media/main.css` - Added new class support
- `src/chatViewProvider.ts` - Added CSS links
- `media/src/ui/tool/ToolCard.ts` - Enhanced components

### **New CSS Files**
- `media/styles/ai-elements-tokens.css`
- `media/styles/components/tool-card.css`
- `media/styles/components/reasoning.css`
- `media/styles/components/chain-of-thought.css`
- `media/styles/components/terminal.css`
- `media/styles/components/plan.css`
- `media/styles/components/queue.css`
- `media/styles/components/checkpoint.css`

## ⚡ **Development Tips**

### **Automatic Rebuild**
The `npm run watch` command is already running, so any changes you make will automatically rebuild:
- **media/src/main.ts** → rebuilds `media/main.js`
- **media/main.css` → copied directly
- **CSS component files** → copied directly

### **Quick Reload Workflow**
1. Make changes to files
2. Wait a few seconds for rebuild
3. Press `Cmd+Shift+P` → `Developer: Reload Window`
4. Test the changes

### **Check Build Status**
```bash
# Check if build succeeded
npm run build

# Check watch mode is running
# (Should show "watching..." messages)
```

## 🎨 **Testing the New UI**

After reloading, try these actions to see the new UI:

1. **Start a chat** that uses tools (search, read, run commands)
2. **Watch for**:
   - Animated progress bars on tool cards
   - "Running" → "Completed" state labels
   - Clickable tool card headers
3. **Check reasoning**:
   - Ask a complex question
   - Look for animated "Thinking" indicator
   - Click reasoning to expand/collapse

## 🐛 **If Still Not Seeing Changes**

### **Clear Extension Cache**
```bash
# Uninstall and reinstall the extension
# In VS Code: Extensions → TierMux → Uninstall → Install again
```

### **Check File Permissions**
```bash
# Ensure CSS files are readable
ls -la media/styles/components/
```

### **Force Rebuild**
```bash
# Stop watch mode, clean rebuild, restart watch
npm run build
npm run watch
```

The new UI **is definitely there** - you just need to reload the extension to see it! 🚀