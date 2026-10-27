"""
异常处理工具

提供统一的异常处理机制，用于捕获和处理应用中的各种异常。
当异常携带 ``error_code`` 时，根据 `Accept-Language` 请求头自动返回
对应语言的本地化错误消息；无 `Accept-Language` 或无 `error_code` 时
沿用原 `detail`，完全向后兼容。
"""
import traceback
from fastapi import Request
from fastapi.responses import JSONResponse
from app.core.exception import BaseException, is_client_error
from app.core.i18n import normalize_locale, get_error_message
from app.utils.logging import get_named_logger

# 创建异常日志记录器
logger = get_named_logger("exception")


def _is_debug_mode() -> bool:
    """检查是否处于调试模式"""
    try:
        from app.core.config import get_config
        config = get_config()
        return getattr(config.app, 'debug', True)
    except Exception:
        return False


def _log_exception(exc: Exception, is_debug: bool = False):
    """
    记录异常信息

    分级口径与 http_exception_handler 对齐，避免预期的客户端拒绝
    （401/403/409 等 4xx）以 ERROR + 完整堆栈进入 error.log 稀释错误信号：
    - 携带 4xx status_code 的业务异常：WARNING 单行，无堆栈
    - 5xx / 未携带状态码的未预期异常：ERROR + 完整堆栈

    日志系统通过处理器分离：
    - app.log (INFO 及以下): 含简化信息
    - error.log (WARNING 及以上): 含完整堆栈跟踪
    """
    exc_type = exc.__class__.__name__
    exc_msg = str(exc) if str(exc) else "Unknown error"

    if is_client_error(exc):
        # 预期的业务拒绝：与 http_exception_handler 的 4xx → warning 口径一致
        logger.warning(f"{exc_type}: {exc_msg}")
        return

    # 简化信息 + 完整堆栈跟踪（均以 ERROR 级别记录）
    # error.log（WARNING 及以上）会自动接收，app.log 的过滤器会跳过
    logger.error(f"{exc_type}: {exc_msg}\n{traceback.format_exc()}")


async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    全局异常处理器

    捕获并处理应用中所有未被捕获的异常。

    自定义异常（继承自 BaseException）已在其 __init__ 中设置了正确的
    status_code，因此无需按子类分别映射状态码。当异常携带 `error_code`
    时，根据 `Accept-Language` 请求头自动翻译 `detail`。
    """
    is_debug = _is_debug_mode()

    _log_exception(exc, is_debug)

    # --- BaseException 及子类 ---
    if isinstance(exc, BaseException):
        # 根据 Accept-Language 翻译 detail
        detail = exc.detail
        if getattr(exc, "error_code", None):
            accept_language = request.headers.get("accept-language")
            locale = normalize_locale(accept_language)
            translated = get_error_message(exc.error_code, locale, default=detail)
            detail = translated or detail

        return JSONResponse(
            status_code=exc.status_code,
            # 转发 WWW-Authenticate 等响应头（401 自定义异常依赖它）
            headers=exc.headers,
            content={
                "detail": detail,
                "error": {
                    "code": exc.status_code,
                    "message": detail,
                    "type": exc.__class__.__name__ if is_debug else "Error",
                    # 稳定业务错误码，前端按码分支而非解析文案
                    "error_code": getattr(exc, "error_code", None),
                },
            },
        )

    # --- 其他未处理异常 ---
    if is_debug:
        error_msg = str(exc) if str(exc) else "Internal Server Error"
        error_type = exc.__class__.__name__
    else:
        error_msg = "Internal Server Error"
        error_type = "InternalServerError"

    return JSONResponse(
        status_code=500,
        content={
            "detail": error_msg if is_debug else "Internal Server Error",
            "error": {
                "code": 500,
                "message": error_msg if is_debug else "Internal Server Error",
                "type": error_type if is_debug else "InternalServerError",
                "error_code": "internal_error",
            },
        },
    )


async def http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """HTTP异常处理器"""
    # 用 Starlette 基类判断：fastapi.HTTPException 是其子类，而路由未匹配
    # 时 Starlette 抛出的 404 只是基类实例，两者都要走同一信封。
    from starlette.exceptions import HTTPException as StarletteHTTPException
    if isinstance(exc, StarletteHTTPException):
        # 记录HTTP异常（4xx客户端错误使用warning，5xx服务器错误使用error）
        if exc.status_code >= 500:
            logger.error(f"HTTP {exc.status_code}: {exc.detail}")
        elif exc.status_code >= 400:
            logger.warning(f"HTTP {exc.status_code}: {exc.detail}")

        # 构建响应头，包含原始异常的 headers（如 WWW-Authenticate）
        headers = exc.headers if exc.headers else {}

        # 兼容仍有 code 的裸 HTTPException：同样按 Accept-Language 翻译
        detail = exc.detail
        error_code = getattr(exc, "error_code", None)
        if error_code:
            locale = normalize_locale(request.headers.get("accept-language"))
            detail = get_error_message(error_code, locale, default=detail) or detail

        return JSONResponse(
            status_code=exc.status_code,
            headers=headers,
            content={
                "detail": detail,
                "error": {
                    "code": exc.status_code,
                    "message": detail,
                    "type": "HTTPException",
                    "error_code": error_code,
                }
            }
        )

    return await global_exception_handler(request, exc)


async def validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """验证异常处理器"""
    from pydantic import ValidationError
    if isinstance(exc, ValidationError):
        # 提取验证错误详情
        error_details = []
        for error in exc.errors():
            field = ".".join(str(item) for item in error["loc"])
            error_details.append({
                "field": field,
                "message": error["msg"],
                "type": error["type"]
            })

        # 记录验证错误
        logger.warning(f"Validation Error: {error_details}")

        locale = normalize_locale(request.headers.get("accept-language"))
        message = get_error_message("validation_error", locale, default="Validation Error")

        return JSONResponse(
            status_code=400,
            content={
                "detail": message,
                "error": {
                    "code": 400,
                    "message": message,
                    "type": "ValidationException",
                    "error_code": "validation_error",
                    "details": error_details
                }
            }
        )

    return await global_exception_handler(request, exc)


async def request_validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    FastAPI 请求体 / 查询参数校验异常处理器

    FastAPI 默认返回裸 ``{"detail": [...]}``，既没有本项目的 ``error`` 信封，
    ``detail`` 又是数组——前端 ``json.detail`` 会拿到数组而显示不出可读文案。
    这里统一成与 ``validation_exception_handler`` 相同的形状：
    ``detail`` 是人类可读消息，逐字段诊断放在 ``error.details``。
    """
    from fastapi.exceptions import RequestValidationError
    if not isinstance(exc, RequestValidationError):
        return await global_exception_handler(request, exc)

    error_details = []
    for error in exc.errors():
        field = ".".join(str(item) for item in error.get("loc", ()))
        error_details.append({
            "field": field,
            "message": error.get("msg", ""),
            "type": error.get("type", ""),
        })

    logger.warning(f"Request Validation Error: {error_details}")

    locale = normalize_locale(request.headers.get("accept-language"))
    message = get_error_message("request_validation_error", locale, default="Validation Error")

    return JSONResponse(
        status_code=422,
        content={
            "detail": message,
            "error": {
                "code": 422,
                "message": message,
                "type": "RequestValidationError",
                "error_code": "request_validation_error",
                "details": error_details,
            },
        },
    )


async def builtin_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Python 内置异常处理器

    处理 ValueError、AttributeError、TypeError 等 Python 内置异常
    防止这些异常未被捕获而导致控制台输出堆栈跟踪
    """
    is_debug = _is_debug_mode()

    # 记录异常
    _log_exception(exc, is_debug)

    # 根据异常类型确定状态码
    status_code = 500
    if isinstance(exc, (ValueError, TypeError)):
        status_code = 400

    if is_debug:
        error_msg = str(exc) if str(exc) else "Internal Server Error"
        error_type = exc.__class__.__name__
    else:
        error_msg = "Internal Server Error"
        error_type = "InternalServerError"

    return JSONResponse(
        status_code=status_code,
        content={
            "detail": error_msg if is_debug else "Internal Server Error",
            "error": {
                "code": status_code,
                "message": error_msg if is_debug else "Internal Server Error",
                "type": error_type if is_debug else "InternalServerError",
                "error_code": "internal_error" if status_code >= 500 else "invalid_request",
            }
        }
    )


def setup_exception_handlers(app):
    """设置异常处理器

    FastAPI 的异常处理器按继承链自动匹配：
    注册 BaseException 即可覆盖所有继承自它的子类，无需逐一注册。
    """
    # 注册 Python 内置异常处理器（最先注册，确保能捕获这些常见异常）
    app.add_exception_handler(ValueError, builtin_exception_handler)
    app.add_exception_handler(AttributeError, builtin_exception_handler)
    app.add_exception_handler(TypeError, builtin_exception_handler)
    app.add_exception_handler(KeyError, builtin_exception_handler)
    app.add_exception_handler(ZeroDivisionError, builtin_exception_handler)

    # 注册自定义异常根处理器
    # 所有继承自 BaseException 的子类（含 RepositoryBrowserException 体系）
    # 会自动由此处理器处理，无需为每个子类单独注册。
    app.add_exception_handler(BaseException, global_exception_handler)

    # 注册FastAPI内置异常处理器
    # 注意用 Starlette 基类注册：路由未匹配时 Starlette 自己抛的 404 不是
    # fastapi.HTTPException 实例，只有按基类注册才同样带上 error 信封。
    from starlette.exceptions import HTTPException as StarletteHTTPException
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)

    # 覆盖 FastAPI 默认的 RequestValidationError 处理器（统一信封）
    from fastapi.exceptions import RequestValidationError
    app.add_exception_handler(RequestValidationError, request_validation_exception_handler)

    # 注册Pydantic验证异常处理器
    from pydantic import ValidationError
    app.add_exception_handler(ValidationError, validation_exception_handler)

    # 注册全局异常处理器（最后注册，作为兜底）
    app.add_exception_handler(Exception, global_exception_handler)
