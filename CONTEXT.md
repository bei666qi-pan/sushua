# Domain glossary

## Workspace

一组具有统一租户边界的学习来源、结构化内容和衍生产物。`workspace_id` 是所有新内容的隔离边界。

## Learner

稳定的个人学习身份。游客和注册用户都通过 Learner 持有 Workspace 与学习记录；登录认领不改变 Learner 身份。

## Guest Session

证明游客可操作某个 Learner 的短期凭证。它不是学习记录的所有者，认领或过期后可以撤销。

## Document

Workspace 中用户可见的逻辑来源文件。

## Document Version

某次上传或重解析形成的不可变来源快照。新的解析结果创建新版本，不覆盖旧版本。

## Block

Document Version 中可定位到页码和 bbox 的最小结构化来源单元。无法识别的内容也必须以 `unknown` Block 保留。

## Question

稳定的题目身份。可编辑内容属于不可变 Question Version。

## Question Version

题干、选项、答案、评分规则、难度和生成元数据的不可变版本。

## Source Reference

Question、Flashcard、Explanation 或 Artifact 与具体 Block 之间的证据关系。

## Attempt

Learner 的一次练习或考试上下文，聚合作答、计时和完成状态。

## Review

Learner 对闪卡的一次评级事件。Review Log 是可重放事实，FSRS 状态是其派生结果。

## Artifact

由 Workspace 内容生成的衍生产物，例如摘要、导出文件、知识图或 PPT。

## Bank

旧题库链接的兼容投影。新业务不再以 Bank 作为聚合根。
