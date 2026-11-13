//go:build windows

package shellreg

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// 权限用"够写就行"的最小集合，而不是 `ALL_ACCESS`。
//
// 两个坑：
//
//   - `ALL_ACCESS` 会连带请求 WRITE_DAC / WRITE_OWNER 之类只属于管理员的
//     能力，普通用户进程直接得到 "Access is denied"；
//   - 只给 `SET_VALUE` 也不够：`Software\Classes\kustos\shell\open\command`
//     是多层路径，创建时还要能往下建子键。
//
// 因此用 SET_VALUE | CREATE_SUB_KEY：写值、建子键，没有别的。
const keyAccess = registry.SET_VALUE | registry.CREATE_SUB_KEY

// protocolKey 是协议注册在 HKCU 下的路径。
func protocolKey(scheme string) string {
	return `Software\Classes\` + scheme
}

// autostartKey 是开机自启所在的 Run 键。
const autostartKey = `Software\Microsoft\Windows\CurrentVersion\Run`

// RegisterProtocol 把本程序注册为此协议的处理程序。
//
// Args:
//
//	scheme: 协议名（不带 `://`）
//	exePath: 可执行文件的绝对路径
//
// Returns:
//
//	写注册表失败时返回错误。
//
// 同时写 `URL Protocol` 空值：没有它，Windows 不会把这个键当作协议处理器，
// 浏览器里点链接只会得到"找不到应用"。这个值是空串而不是某个语义值，
// 它的存在本身就是标记。
func RegisterProtocol(scheme, exePath string) error {
	root, _, err := registry.CreateKey(registry.CURRENT_USER, protocolKey(scheme), keyAccess)
	if err != nil {
		return fmt.Errorf("创建协议注册项失败: %w", err)
	}
	defer func() { _ = root.Close() }()

	if err := root.SetStringValue("", "URL:"+scheme+" protocol"); err != nil {
		return fmt.Errorf("写入协议描述失败: %w", err)
	}
	if err := root.SetStringValue("URL Protocol", ""); err != nil {
		return fmt.Errorf("写入协议标记失败: %w", err)
	}

	command, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		protocolKey(scheme)+`\shell\open\command`,
		keyAccess,
	)
	if err != nil {
		return fmt.Errorf("创建协议命令项失败: %w", err)
	}
	defer func() { _ = command.Close() }()

	if err := command.SetStringValue("", ProtocolCommand(exePath)); err != nil {
		return fmt.Errorf("写入协议命令失败: %w", err)
	}
	return nil
}

// UnregisterProtocol 移除协议注册。
//
// Returns:
//
//	键本来就不存在时返回 nil（撤消一个不存在的注册不是错误）。
func UnregisterProtocol(scheme string) error {
	if err := registry.DeleteKey(registry.CURRENT_USER, protocolKey(scheme)); err != nil {
		if err == registry.ErrNotExist {
			return nil
		}
		return fmt.Errorf("移除协议注册失败: %w", err)
	}
	return nil
}

// ProtocolRegistered 判断协议是否已注册到指定的可执行文件。
//
// Args:
//
//	scheme: 协议名
//	exePath: 期望的可执行文件绝对路径
//
// Returns:
//
//	已注册且命令指向同一路径时为 true。
//
// 比 "键存在" 更严：程序升级或换了安装位置之后，旧注册项会指向一个不存在的
// 路径，点链接的表现是"什么都没发生"。那算没注册对。
func ProtocolRegistered(scheme, exePath string) bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, protocolKey(scheme)+`\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer func() { _ = key.Close() }()

	value, _, err := key.GetStringValue("")
	if err != nil {
		return false
	}
	return value == ProtocolCommand(exePath)
}

// SetAutostart 开启或关闭开机自启。
//
// Args:
//
//	enabled: true 写入 Run 值，false 删除
//	exePath: 可执行文件的绝对路径
//
// Returns:
//
//	写注册表失败时返回错误。
func SetAutostart(enabled bool, exePath string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, autostartKey, keyAccess)
	if err != nil {
		return fmt.Errorf("打开开机自启键失败: %w", err)
	}
	defer func() { _ = key.Close() }()

	if !enabled {
		if err := key.DeleteValue(RunValueName); err != nil && err != registry.ErrNotExist {
			return fmt.Errorf("移除开机自启失败: %w", err)
		}
		return nil
	}
	if err := key.SetStringValue(RunValueName, AutostartCommand(exePath)); err != nil {
		return fmt.Errorf("写入开机自启失败: %w", err)
	}
	return nil
}

// AutostartEnabled 判断开机自启是否开着。
//
// Args:
//
//	exePath: 期望的可执行文件绝对路径
//
// Returns:
//
//	值存在且指向同一路径时为 true。
//
// 同样比 "值存在" 更严：换了安装位置之后旧值指向不存在的文件，
// 系统每次登录都会尝试启动一个不存在的路径，而对用户来说那等于没开。
func AutostartEnabled(exePath string) bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, autostartKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer func() { _ = key.Close() }()

	value, _, err := key.GetStringValue(RunValueName)
	if err != nil {
		return false
	}
	return value == AutostartCommand(exePath)
}
