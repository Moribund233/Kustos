import ast
import pathlib

import pytest

from app.core.i18n import (
    get_error_message,
    normalize_locale,
    ERROR_MESSAGES,
    LOCALE_ZH,
    LOCALE_EN,
)


def test_normalize_locale_zh():
    assert normalize_locale("zh-CN,zh;q=0.9,en;q=0.8") == "zh"


def test_normalize_locale_en():
    assert normalize_locale("en-US,en;q=0.9,zh;q=0.8") == "en"


def test_normalize_locale_missing_defaults_to_zh():
    assert normalize_locale(None) == "zh"
    assert normalize_locale("") == "zh"


def test_normalize_locale_unsupported_falls_back_to_zh():
    assert normalize_locale("ja-JP") == "zh"


def test_normalize_locale_prefers_first_supported():
    assert normalize_locale("fr-FR,en;q=0.9") == "en"


def test_get_error_message_zh():
    assert get_error_message("room_not_found", LOCALE_ZH) == "房间不存在"


def test_get_error_message_en():
    assert get_error_message("room_not_found", LOCALE_EN) == "Room not found"


def test_get_error_message_unknown_code_uses_default():
    assert get_error_message("no_such_code", LOCALE_ZH, default="fallback") == "fallback"


def test_get_error_message_none_code_returns_default():
    assert get_error_message(None, LOCALE_ZH, default="raw") == "raw"


def test_error_catalog_has_both_languages():
    for code, mapping in ERROR_MESSAGES.items():
        assert LOCALE_ZH in mapping, f"{code} missing zh"
        assert LOCALE_EN in mapping, f"{code} missing en"


def test_error_catalog_all_messages_nonempty():
    for code, mapping in ERROR_MESSAGES.items():
        assert mapping[LOCALE_ZH].strip() != "", f"{code} has empty zh message"
        assert mapping[LOCALE_EN].strip() != "", f"{code} has empty en message"


def test_error_catalog_biz_domains_covered():
    for code in (
        "repository_not_found",
        "repository_path_already_exists",
        "branch_not_found",
        "commit_not_found",
        "issue_not_found",
        "pr_not_found",
        "label_not_found",
        "member_not_found",
        "webhook_not_found",
        "webhook_invalid_url",
        "build_not_found",
        "release_not_found",
        "ssh_key_not_found",
        "notification_not_found",
        "user_not_found",
        "invalid_credentials",
        "invalid_refresh_token",
        "repository_access_denied",
        "pr_merge_conflict",
        "collab_invalid_dockey",
    ):
        assert code in ERROR_MESSAGES, f"{code} missing from error catalog"
        assert ERROR_MESSAGES[code][LOCALE_ZH]
        assert ERROR_MESSAGES[code][LOCALE_EN]


def test_get_error_message_domain_samples():
    samples = {
        ("repository_not_found", "zh"): "仓库不存在",
        ("repository_not_found", "en"): "Repository not found",
        ("webhook_invalid_url", "zh"): "无效的 URL",
        ("webhook_invalid_url", "en"): "Invalid URL",
        ("pr_not_found", "zh"): "Pull Request 不存在",
        ("pr_not_found", "en"): "Pull request not found",
        ("attachment_content_empty", "zh"): "附件内容为空",
        ("attachment_content_empty", "en"): "Attachment content is empty",
    }
    for (code, locale), expected in samples.items():
        assert get_error_message(code, locale) == expected, f"{code}/{locale}"


def test_exception_carries_error_code_for_translation():
    from app.core.exception import (
        NotFoundException,
        AuthorizationException,
        ConflictException,
        AuthenticationException,
        InvalidPathException,
        RepositoryNotFoundException,
        PathNotFoundException,
    )

    exception_types = [
        NotFoundException("仓库不存在", error_code="repository_not_found"),
        AuthorizationException("Permission Denied", error_code="repository_access_denied"),
        ConflictException("冲突", error_code="repository_path_already_exists"),
        AuthenticationException("auth failed", error_code="invalid_credentials"),
        InvalidPathException("invalid path", error_code="path_required"),
        RepositoryNotFoundException("not found", error_code="repository_not_found"),
        PathNotFoundException("not found", error_code="path_not_found"),
    ]
    for exc in exception_types:
        assert exc.error_code is not None


# ===========================================================================
# error_code → 词条覆盖扫描（防「有码无词条 / 无码不翻译」回潮）
# ===========================================================================

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
_SOURCE_DIRS = ("api", "core", "services", "middleware", "utils")

#: 有意保留原始 detail 的错误码：其 detail 是**动态诊断**
#: （底层 git/pygit2/外部服务的原始错误文本），一旦补入静态词条，
#: ``global_exception_handler`` 会用通用文案覆盖这些诊断信息
#: （见 ``tests/test_error_contract.py::test_unmapped_error_code_keeps_dynamic_detail``）。
#: 因此这些码必须保持**不在** ``ERROR_MESSAGES`` 中。
DYNAMIC_DETAIL_CODES = {
    "branch_create_failed",          # detail=str(git 错误)
    "branch_delete_failed",          # detail=str(git 错误)
    "branch_source_ref_not_found",   # detail 指明缺失的是哪个 ref
    "debug_config_reset_failed",     # detail=join(各子项失败原因)
    "debug_db_reset_failed",         # detail=f"...: {底层异常}"
    "destination_exists",            # detail 指明冲突的具体路径
    "file_too_large",                # detail=f"…上限（{N}MB）"，动态阈值
    "git_hook_rejected",             # detail=拒绝原因，git 客户端直接展示
    "grafana_login_failed",          # detail=f"...: {底层异常}"
    "invalid_git_repository",        # detail=pygit2 原始异常
    "lfs_operation_failed",          # detail=str(底层异常)
    "merge_conflict_check_failed",   # detail=str(底层异常)
    "merge_failed",                  # detail=str(底层异常)
    "monitoring_control_failed",     # detail=str(底层异常)
    "monitoring_not_deployed",       # detail=str(底层异常)
    "oauth_error",                   # detail=str(底层异常)
    "repo_size_exceeded",            # detail=f"…上限（{N}MB）"，动态阈值
    "rebase_failed",                 # detail=str(底层异常)
    "squash_merge_failed",           # detail=str(底层异常)
}


def _collect_source_error_codes() -> set:
    """扫描源码里出现的 error_code 字面量（keyword 赋值两种写法）。"""
    codes: set = set()
    for dirname in _SOURCE_DIRS:
        base = _PROJECT_ROOT / "app" / dirname
        if not base.is_dir():
            continue
        for path in base.rglob("*.py"):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.keyword) and node.arg == "error_code":
                    if isinstance(node.value, ast.Constant) and isinstance(
                        node.value.value, str
                    ):
                        codes.add(node.value.value)
                elif isinstance(node, ast.Assign):
                    for target in node.targets:
                        if (
                            isinstance(target, ast.Name)
                            and target.id == "error_code"
                            and isinstance(node.value, ast.Constant)
                            and isinstance(node.value.value, str)
                        ):
                            codes.add(node.value.value)
    return codes


def test_source_error_code_scan_actually_finds_codes():
    """金丝雀：扫描器必须真的跑起来（路径写错会得到空集 → 假绿）。"""
    codes = _collect_source_error_codes()
    assert len(codes) > 200, f"扫描到的 error_code 过少（{len(codes)}），扫描器可能失效"


def test_every_source_error_code_is_translated_or_dynamic():
    """源码中每个 error_code 要么有词条，要么在 DYNAMIC_DETAIL_CODES 中显式豁免。"""
    codes = _collect_source_error_codes()
    missing = sorted(
        c for c in codes
        if c not in ERROR_MESSAGES and c not in DYNAMIC_DETAIL_CODES
    )
    assert missing == [], (
        "以下 error_code 缺少 i18n 词条（要么补词条，要么确认其 detail 是动态诊断"
        "并加入 DYNAMIC_DETAIL_CODES）:\n" + "\n".join(f"  {c}" for c in missing)
    )


def test_dynamic_detail_codes_stay_unmapped():
    """DYNAMIC_DETAIL_CODES 必须保持未映射——否则动态 detail 会被静态文案覆盖。"""
    conflicted = sorted(c for c in DYNAMIC_DETAIL_CODES if c in ERROR_MESSAGES)
    assert conflicted == [], (
        "这些码同时在 DYNAMIC_DETAIL_CODES 与 ERROR_MESSAGES 中（detail 会被覆盖）:\n"
        + "\n".join(f"  {c}" for c in conflicted)
    )


def test_dynamic_detail_codes_all_used_in_source():
    """豁免清单里的码必须仍在源码中使用——已消失的码要及时摘除。"""
    codes = _collect_source_error_codes()
    stale = sorted(c for c in DYNAMIC_DETAIL_CODES if c not in codes)
    assert stale == [], f"DYNAMIC_DETAIL_CODES 中已无引用的码: {stale}"
