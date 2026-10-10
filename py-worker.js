importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js');
const ready = loadPyodide();

onmessage = async ({ data: { id, code } }) => {
  const py = await ready;
  let out = '';
  py.setStdout({ batched: s => out += s + '\n' });
  py.setStderr({ batched: s => out += s + '\n' });
  try {
    await py.loadPackagesFromImports(code);
    const result = await py.runPythonAsync(code);
    if (result !== undefined) out += String(result);
  } catch (e) {
    out += e.message;
  }
  postMessage({ id, out: out || '(no output)' });
};
