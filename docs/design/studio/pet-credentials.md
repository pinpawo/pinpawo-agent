# Pet 凭据

> 状态：实现中（替代 PR #1020 的精简版）
> 更新：2026-10-29

## 问题

同一份定义可以建两个 Pet（[Pet 实例](pet-instance.md)），它们常常要用不同的账号：两个开发助手各推各的
GitHub 账号、各用各的服务 token。现在工具只继承 Host 进程的环境变量，所有 Pet 拿到的是同一套，
没法让某个 Pet 有自己的凭据。

## 决定

- **凭据属于 Pet 实例**，不属于定义。定义被多个 Pet 共用，把凭据挂在定义上等于给所有实例同一个身份。
- **存在 Studio core**，和 `studio_pets` 同一份迁移历史（owner `studio`）。不做成 Plugin：解密必须只走
  Host 的可信路径，不经过任何 Plugin；也不放 Host：Host 不知道“实例”这个领域概念。
- **一对一按实例存值**，没有独立的 Secret 表，也没有多个 Pet 共享同一个 Secret 的引用。改一个 Pet 的值
  只影响这个 Pet。
- **只注入 ShellRS 命令的环境变量**。shell、git、gh 与 project inspection 共用一个 ShellRS client，所以它们都拿到；
  其他工具不拿。凭据不进模型上下文、不进事件和 checkpoint。
- **值只写不读**：管理接口只返回变量名和更新时间，没有读取明文的接口。

## 存储

```sql
CREATE TABLE studio_pet_credentials (
  pet_id          TEXT NOT NULL REFERENCES studio_pets(pet_id) ON DELETE CASCADE,
  env_name        TEXT NOT NULL,   -- 环境变量名：字母、数字、_，不以数字开头
  encrypted_value TEXT NOT NULL,   -- AES-256-GCM 信封 {v, nonce, tag, ciphertext}
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (pet_id, env_name)
);
```

每次写入用新的随机 nonce；`[petId, envName]` 作为附加认证数据，密文搬到别的行会解密失败。

## 密钥

- `studio.json` 的 `credentials.keyFile` 指向密钥文件（绝对路径，内容是 32 字节的 base64）。
- `pinpawo-studio init` 在 workdir 外的 Studio 数据目录（`~/.pinpawo/studios/<uuid>/`，和 Wiki 同级）生成
  `credentials.key`，权限 0600，并写进 `studio.json`。数据库在 workdir 里（默认 `.pinpawo/studio/studio.sqlite`），
  密钥不和它放在一起，误提交或备份数据库不会同时带走密钥。
- Host 启动时读取：文件必须是普通文件、只有所有者可读（非 Windows）、内容正好 32 字节，否则启动失败。
- 没有 `credentials` 配置时凭据**锁定**：能列出变量名、能删除，但不能写入；没有凭据的 Pet 照常运行，
  有凭据的 Pet 运行命令时失败（不回退到其他身份）。已有 workdir 想启用，自己生成一个密钥文件并加上配置即可。
- 不做密钥轮换；换密钥后旧值无法解密，需要重新设置。

## 运行时

```ts
interface PetCredentialSource {
  environment(petId: string): Promise<Readonly<Record<string, string>>>;
}
```

- resident turn runner 在每个 turn（交互、dispatch、resume）外面绑定这个 Pet 的 `petId`（AsyncLocalStorage，
  和 `petInvocationContext` 同一种做法）；turn 结束后身份失效。
- ShellRSClient 每次 `exec` 前取当前 Pet 的变量，只加到这一次请求的 `env`，同名时覆盖 Toolkit 给的值。
  不改 Host 全局环境，不缓存；改了值，之后启动的命令拿到新值，已经在跑的进程不变。
- 没有活跃的 Pet turn、取值失败或解密失败时，命令不启动；错误不带原因，避免把值带进日志。
- Studio Host 在 `HostCapabilityAssembly.init({credentialSource})` 时把 source 交给装配，默认装配和调用者传入的装配
  走同一条路，不会出现“命令照跑、却只带 Host 环境”的情况；同一装配再次 init 换了 source 会报错。
  不对外开其他注入口。Chat Host 不传 source，行为不变。

边界：这是进程环境注入，**不是沙箱**。shell 可以打印自己的环境变量，命令输出不做脱敏；
同一用户的文件和进程访问也不在隔离范围内。Host 和 RS 服务自身的全局环境照旧继承，
所以不要把 Pet 的凭据或密钥放进那里。

## 管理

`StudioPets.credentials`（Plugin context 上的 `pets` 端口的一部分，和创建、改名同一个管理面）：

```ts
type StudioPetCredentials = {
  unlocked: () => boolean;
  list: (petId) => Promise<Array<{ envName: string; updatedAt: string }>>;
  set: (input: { petId; envName; value }) => Promise<{ envName: string; updatedAt: string }>;
  remove: (input: { petId; envName }) => Promise<{ removed: boolean }>;
};
```

- studio-http，只接受本机 token：`GET /pet-credentials?petId=` → `{unlocked, credentials}`；
  `POST /pet-credentials {petId, envName, value}`；`POST /pet-credentials/remove {petId, envName}`。
  错误码：参数不合法 400，Pet 不存在 404，锁定 503。
- CLI：`pinpawo-studio pets credentials <petId>`、`pets set-credential <petId> --env <NAME> --file <value|->`
  （值从文件或 stdin 原样读入，包括末尾换行，不做任何修改；不进 shell 历史）、`pets unset-credential <petId> --env <NAME>`。
- Console 管理页随 #1015 第三阶段（Pet 管理页）一起做。

## 不做

- 多个 Pet 共享一个 Secret、Secret 独立命名与引用。
- 条件写入（CAS）和整组替换；单项设置与删除就够。
- 文件存储等第二种来源、对外的 source 注入口。
- 密钥轮换、外部 Vault / Secret Manager。
- 业务授权流程（登录、OAuth、签发）；它们最后都落成“给某个 Pet 设一个变量”。
