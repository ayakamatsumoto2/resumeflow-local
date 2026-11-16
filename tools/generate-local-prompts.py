#!/usr/bin/env python3
"""ResumeFLOW Local Edition — 从原版后端的 Python 提示词常量生成 TypeScript 模块。

本地版的 AI 逻辑运行在前端，但提示词仍以 backend/app 里的原文为唯一来源，
避免手工抄写造成偏差。用法（在仓库根目录）：

    python3 tools/generate-local-prompts.py

输出：local/ai/prompts.generated.ts
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
AI_DIR = ROOT / "backend" / "app" / "domain" / "ai"
PARSER_DIR = ROOT / "backend" / "app" / "domain" / "parser"


def load_constants(path: pathlib.Path, injected: dict | None = None) -> dict:
    source = path.read_text(encoding="utf-8")
    # 这些模块只包含常量；去掉包内相对导入，改为注入依赖值。
    source = re.sub(r"^from \.[\w.]* import .*$", "", source, flags=re.MULTILINE)
    namespace: dict = dict(injected or {})
    exec(compile(source, str(path), "exec"), namespace)  # noqa: S102 - 仅执行本仓库内的常量模块
    return namespace


def extract_dict_literal(path: pathlib.Path, name: str):
    source = path.read_text(encoding="utf-8")
    match = re.search(rf"^{name}[^=\n]*=\s*", source, flags=re.MULTILINE)
    if not match:
        raise SystemExit(f"{name} not found in {path}")
    start = match.end()
    depth = 0
    for index in range(start, len(source)):
        char = source[index]
        if char in "{(":
            depth += 1
        elif char in "})":
            depth -= 1
            if depth == 0:
                return eval(source[start:index + 1], {})  # noqa: S307 - 仓库内常量字面量
    raise SystemExit(f"unterminated literal for {name}")


rubric = load_constants(AI_DIR / "resume_evaluation_rubric.py")
prompts = load_constants(AI_DIR / "prompts.py", {"SHARED_RUBRIC": rubric["SHARED_RUBRIC"]})
parser_prompts = load_constants(PARSER_DIR / "prompts.py")
skill_prompts = extract_dict_literal(AI_DIR / "assistant_turn_utils.py", "ASSISTANT_SKILL_PROMPTS")


def public_constants(namespace: dict) -> dict:
    return {
        key: value
        for key, value in namespace.items()
        if key.isupper() and isinstance(value, (str, dict, list, tuple, int, float))
    }


payload = {
    "AI_PROMPTS": public_constants(prompts),
    "PARSER_PROMPTS": public_constants(parser_prompts),
    "ASSISTANT_SKILL_PROMPTS": skill_prompts,
}

lines = [
    "/* eslint-disable */",
    "// 此文件由 tools/generate-local-prompts.py 自动生成，请勿手工修改。",
    "// 来源：backend/app/domain/ai/prompts.py、resume_evaluation_rubric.py、",
    "//       backend/app/domain/parser/prompts.py、assistant_turn_utils.py",
    "",
]
for name, value in payload.items():
    lines.append(f"export const {name} = {json.dumps(value, ensure_ascii=False, indent=2)} as const;")
    lines.append("")

output = ROOT / "local" / "ai" / "prompts.generated.ts"
output.write_text("\n".join(lines), encoding="utf-8")
print(f"wrote {output.relative_to(ROOT)}:")
for name, value in payload.items():
    print(f"  {name}: {', '.join(value.keys())}")
