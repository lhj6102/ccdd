# Folder composition and logical mounts

`explosion/ccdd.json` owns the parent's tools and Critics. The nearest marked children, `effect` and `preview`, remain separate Artifacts. The parent automatically depends on both. `style` and `theme` are logical mounts to sibling Artifacts; no directories, copies or symlinks are created for them.

Install `@ccdd/core`, `@ccdd/project` and `@ccdd/default-tools` in this directory, then run:

```sh
ccdd-project config check
ccdd-project graph explosion --json
ccdd-project tools check --artifact explosion --for agent --tool blind_pair --execute
ccdd-project verify explosion --recursive --wait
```

The last command uses real Agent evaluation. No verdict is included in this example. The theme and screenshot intentionally use the same supplied sample image; replace them before using this as a project criterion.

The coding-style Critic references `{style}` through the existing instruction template. The blind comparison procedure is a normal user script: it resolves the theme mount and preview child, randomizes A/B, returns images, and writes its private mapping to the external output directory. The Critic instructs its reviewer not to open named views. That is a review procedure, not an access-control guarantee against a reviewer who deliberately ignores it. CCDD adds no presentation-specific runner. The other Critic demonstrates direct `{effect}` and `{preview}` references.

Repeated mounts share the canonical Artifact and its evidence. Each Artifact controls its own tools; parent declarations do not merge child Critics or views.
