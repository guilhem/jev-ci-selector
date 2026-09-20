/** A complete unified Git patch; large fixtures contain many complete lines. */
export function patch(lines = 1, path = 'source.txt'): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n` + '+SECRET-SOURCE-SENTINEL café 🦄 content\n'.repeat(lines);
}
