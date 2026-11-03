# apitest-server tsconfig rootDir 报错 — 问题记录

日期：2026-08-12

## 现象

`apitest-server` 执行 TypeScript 编译/类型检查时报告：

```
The common source directory of 'tsconfig.json' is './src'. The 'rootDir' setting must be explicitly set to this or another path to adjust your output's file layout.
请访问 https://aka.ms/ts6 以获取迁移信息。
```

## 根因

TS 6 迁移检查要求：当所有源码位于同一公共目录（`./src`）时，`rootDir` 必须显式声明，否则输出文件布局可能不符合预期。`apitest-server/tsconfig.json` 原先只有 `outDir: "dist"`，未设置 `rootDir`。

## 修复

在 `apitest-server/tsconfig.json` 的 `compilerOptions` 中显式添加 `"rootDir": "src"`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

验证：`pnpm run check`（tsc --noEmit）通过。

## 经验总结

1. **`outDir` 与 `rootDir` 需成对出现**：只要指定了 `outDir`，就应同时显式指定 `rootDir`，避免依赖隐式推导；TS 新版本（6.x 迁移检查）会强制要求。
2. **迁移错误先看 `https://aka.ms/ts6`**：这类报错通常对应 TS 编译器的迁移/破坏性变更清单，按提示补齐配置即可。
