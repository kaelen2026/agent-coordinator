// 复用 better-auth 自己的 IP/CIDR 解析（`./utils/*` 是 @better-auth/core 声明的公开
// 子路径导出），而不是手写这段安全敏感的解析。
//
// ⚠️ better-auth 把 @better-auth/core 锁成精确版本依赖，我们这里也锁精确版本：
// 两者必须**同版本同步升级**，否则本文件与 better-auth 内部用的可能是两份语义不同的
// 实现，而分桶行为不一致是不会报错的。升 better-auth 时记得一起升。
import { getIPFromHeader, normalizeIP } from "@better-auth/core/utils/ip";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

/**
 * 信任边界上由本服务写入的内部头，写入时覆盖任何同名外部输入。
 * better-auth 的限流只从这个头取客户端 IP，因此它拿到的地址与本服务的限流完全一致。
 * 故意不用 x-forwarded-for / x-real-ip 这类标准名，避免与代理写的头混淆。
 */
export const CLIENT_IP_HEADER = "x-agent-coordinator-client-ip";

/** 实在识别不出客户端时的兜底桶。落到这里的请求共享限流额度，是有意的保守行为。 */
export const UNKNOWN_CLIENT_IP = "unknown";

const FORWARDED_HEADER = "x-forwarded-for";

/**
 * 解析请求的真实客户端 IP，用作限流分桶键。
 *
 * 只有配置了可信代理才看 X-Forwarded-For，且从右往左跳过可信跳、取第一个不可信跳——
 * 客户端可以往链首塞任意值，左边的部分永远不可信。没有可信代理时（直连暴露）只认
 * socket 地址，它是唯一不可伪造的来源。
 */
export const resolveClientIp = (
  headers: Headers,
  socketAddress: string | undefined,
  trustedProxies: string[],
): string => {
  if (trustedProxies.length > 0) {
    const forwarded = headers.get(FORWARDED_HEADER);
    const fromChain = forwarded === null ? null : getIPFromHeader(forwarded, { trustedProxies });
    if (fromChain !== null) {
      return fromChain;
    }
  }

  if (socketAddress !== undefined && socketAddress.length > 0) {
    return normalizeIP(socketAddress);
  }

  return UNKNOWN_CLIENT_IP;
};

export type ClientIpEnv = { Variables: { clientIp: string } };

// @hono/node-server 把底层 Node 请求挂在 c.env.incoming 上；测试里用 app.request()
// 直接打内存 app 时没有这一层，所以按外部数据校验、拿不到就当没有 socket。
const nodeServerEnvSchema = z.object({
  incoming: z.object({
    socket: z.object({ remoteAddress: z.string().optional() }),
  }),
});

/**
 * 信任边界：把真实客户端 IP 解析出来，写进内部头并**覆盖**客户端可能自带的同名头。
 * 下游（本服务限流、better-auth 限流）一律只认这个头，不存在"客户端自选限流桶"的口子。
 *
 * 唯一的例外是连 socket 地址都取不到、只能落到 UNKNOWN_CLIENT_IP 的防御分支：那不是
 * 合法 IP，better-auth 会拒收并退回它自己的全局桶，两侧分桶在这条路径上并不一致。
 * 真实 @hono/node-server 下 socket 地址总能取到，所以这条分支实际走不到。
 */
export const clientIpMiddleware = (trustedProxies: string[]) =>
  createMiddleware<ClientIpEnv>(async (c, next) => {
    const parsed = nodeServerEnvSchema.safeParse(c.env);
    const socketAddress = parsed.success ? parsed.data.incoming.socket.remoteAddress : undefined;

    const clientIp = resolveClientIp(c.req.raw.headers, socketAddress, trustedProxies);
    c.req.raw.headers.set(CLIENT_IP_HEADER, clientIp);
    c.set("clientIp", clientIp);

    await next();
  });
