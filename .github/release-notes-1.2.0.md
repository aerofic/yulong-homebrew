# v1.2.0 — Selected creature range outlines

- 新增默认关闭的本机设置「选中生物时显示范围线（仅 GM）」。GM 单选生物时显示淡色、不填充、不可交互的范围轮廓；取消选择或关闭功能时自动清理。
- 显示超过 5 尺的近战触及、已准备的灵光，以及动作／特性中明确标注的自身发散范围。
- 显示远程攻击首个射程增量或固定射程，不显示多倍射程增量和最大射程线。
- 方格地图使用 PF2e 的最近占格测距：自身格不计距离，邻格为 5 尺。仅近战触及采用 10 尺触及斜向两格的特例；灵光、发散及远程不采用该特例。
- 同类同距离范围合并名称；不改变原生灵光、不创建模板或修改世界文档。

## Boundaries and verification

- Targets Foundry VTT V14 and PF2e. Isolated runtime verification used Foundry 14.367 / PF2e 8.5.1; full on-map visual and multi-client acceptance remain unverified.
- Square-grid outlines are planar distance references, not wall, cover, line-of-effect or elevation checks. Gridless maps use a geometric outline; hex grids are not supported.
- Description recognition is conservative: explicit reach/self-area fields and emanation template links only. It does not infer arbitrary conditional prose or display spell bursts/cones.
- 62 automated tests passed, including footprint geometry, the 10-foot reach exception, ranged data, GM gating, redraw coalescing and cleanup. Manifest validation passed.
- No migrations. Refresh the GM client after deployment to load the new entrypoint, then enable the local setting if desired.
