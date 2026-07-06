import Foundation
import Core

public enum AgentEnv {
    // agent-server 经 nginx /agent/ 反代;base = <主站 origin>/agent/api。
    static var base: String { APIEnvironment.current.baseURLString + "/agent/api" }
}
