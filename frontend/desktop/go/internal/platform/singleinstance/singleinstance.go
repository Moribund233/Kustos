// Package singleinstance 提供桌面端的单实例约束。
//
// 为什么需要：常驻应用被双击第二次时，用户期望的是"把已有窗口叫到前面"，
// 而不是开出第二个进程。两个进程会各自持有一份 SQLite 连接与一份会话状态，
// 在本地事实（工作副本、草稿、UI 状态）上互相覆盖。
package singleinstance

import (
	"crypto/sha256"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// UniqueID 是本应用的实例标识。
//
// 取反向域名而非产品名：Windows 用它做互斥量名、Linux 用它做锁文件名，
// 与其它应用撞名会让两个不相关的程序互相"单实例化"。
const UniqueID = "com.kustos.desktop"

// ExitCode 是第二实例把参数转交给第一实例后退出时的退出码。
//
// 刻意用 0 而不是非零：这是正常行为（用户双击了一次，已有窗口被唤到前面），
// 不是错误。脚本或安装器据此判断"启动成功"时不该看到失败。
const ExitCode = 0

// encryptionKey 是第二实例与第一实例之间传递参数的加密密钥。
//
// 必须是**编译期固定的常量**：每次启动随机生成的话，第二实例用新密钥加密、
// 第一实例用旧密钥解密，两边根本对不上，转交的参数会被静默丢弃。
//
// 它防的是本机其它进程伪造参数注入，不是防抵赖——密钥随二进制分发，
// 拿到二进制的人自然能算出它。因此转交过来的参数仍然要按不可信输入校验，
// 加密只是把"随便谁都能发"收窄成"至少要读得懂本程序"。
func encryptionKey() [32]byte {
	return sha256.Sum256([]byte("kustos-desktop:single-instance:v1"))
}

// Options 返回单实例配置。
//
// Args:
//
//	onSecondLaunch: 第二实例启动时被调用（运行在第一实例的 goroutine 里）
//
// Returns:
//
//	可直接填入 application.Options.SingleInstance 的配置。
func Options(onSecondLaunch func(application.SecondInstanceData)) *application.SingleInstanceOptions {
	return &application.SingleInstanceOptions{
		UniqueID:               UniqueID,
		ExitCode:               ExitCode,
		EncryptionKey:          encryptionKey(),
		OnSecondInstanceLaunch: onSecondLaunch,
	}
}

// ShouldIgnoreArgs 判断第二实例传来的参数是否可安全忽略。
//
// Returns:
//
//	true 表示这组参数不需要处理（没有需要转交给第一实例的意图）。
//
// 当前桌面端还没有深链路由，第二实例除了参数外没有别的语义；
// 把参数一律视为不可信并忽略，比先实现一个半成品的手势安全。
// 等深链落地后，这里改为解析 URL 并投递给第一实例的 deeplink 队列。
func ShouldIgnoreArgs(args []string) bool {
	return len(args) <= 1
}
