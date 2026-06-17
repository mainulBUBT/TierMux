// Single source of truth for the product/extension display name.
//
// Change PRODUCT_NAME here and every runtime + webview reference updates with it.
// The static manifest (package.json) is read by VS Code before any code runs, so
// it can't import this — run `npm run rebrand` after changing this value to sync
// package.json's display fields (displayName, view title, command categories).
export const PRODUCT_NAME = 'TierMux';
