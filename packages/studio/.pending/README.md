# 待迁移到 `@pinpawo-toolkit/studio-kanban` 的测试

`wiki-fs-tests.txt.hold` 里是两个断言**文件系统布局**的测试:

- `pet runtime passes wiki read tools and operation metadata when wikiRoot is provided`
- `wiki curator writes per-task source file and updates index`

它们原本在 pet-agent 的 studio 子树里。抽包后 wiki 的文件实现归 kanban toolkit,
这两个测试应随实现一起迁过去 —— 编排核心只依赖 `wikiPort` 接口,不该断言磁盘布局。

迁移完成后删除本目录。见 `docs/STUDIO_PACKAGE_EXTRACTION_PLAN.md` 第 3 步。
