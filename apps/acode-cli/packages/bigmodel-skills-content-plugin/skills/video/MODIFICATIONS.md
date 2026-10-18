# 2026-10-09 适配版变更

本文件说明相对于上游版本的修改；包内使用规则不替代实际运行环境的权限、安全及合规控制。
原包编号：S024；原名称：video；原 ZIP SHA-256：88a42ec567cbe265f2a0b5651b6f4ffbc6ac4a1554b8ca0846e84d633c316e82。

原 LICENSE 与 UPSTREAM.md 原样保留；原有版权、许可和署名继续适用，不改标专有许可，不表示上游背书。已移除内容不随本包重新分发。

移除动态安装及默认服务推荐；保留脚本、分镜，实际制作需已审工具。

- 修改：SKILL.md
- 修改：evals/evals.json
- 修改：references/ai-video-prompting.md
- 修改：references/edit-anatomy.md

原入口元数据（历史来源记录，不代表本版运行依赖或当前批准）：
```json
{
  "name": "video",
  "description": "When the user wants to create, generate, or produce video content using AI tools or programmatic frameworks. Also use when the user mentions 'video production,' 'AI video,' 'Remotion,' 'Hyperframes,' 'HeyGen,' 'Synthesia,' 'Veo,' 'Sora,' 'Runway,' 'Kling,' 'Seedance,' 'Hailuo,' 'MiniMax,' 'Pika,' 'Hunyuan,' 'Wan,' 'video generation,' 'AI avatar,' 'talking head video,' 'programmatic video,' 'video template,' 'explainer video,' 'product demo video,' 'video pipeline,' 'copy this edit,' 'match this video style,' 'reverse-engineer this video,' 'edit like this reference,' or 'make me a video.' Use this for video creation, generation, and production workflows. For video content strategy and what to post, see social. For paid video ad creative, see ad-creative.",
  "metadata": {
    "version": "2.1.0"
  }
}
```
