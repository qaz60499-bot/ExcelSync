// npm's dev flag describes installation, not what Electron bundles or executes.
function runtimeDependencies(pkg, packages, bundledRoots = []) {
  const reachable = new Set()
  function resolve(from, name) {
    let parent = from
    for (;;) {
      const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`
      if (packages[candidate]) return candidate
      const index = parent.lastIndexOf('/node_modules/')
      if (index >= 0) parent = parent.slice(0, index)
      else if (parent) parent = ''
      else return null
    }
  }
  function visit(nodePath) {
    if (!nodePath || reachable.has(nodePath)) return
    reachable.add(nodePath)
    const meta = packages[nodePath]
    for (const name of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
      visit(resolve(nodePath, name))
    }
  }
  for (const name of [...Object.keys(pkg.dependencies || {}), ...bundledRoots]) visit(resolve('', name))
  // The npm package installs the shipped runtime; its helper dependencies run at build time.
  if (packages['node_modules/electron']) reachable.add('node_modules/electron')
  return reachable
}

module.exports = { runtimeDependencies }
