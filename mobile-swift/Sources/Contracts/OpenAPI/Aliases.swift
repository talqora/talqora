import Foundation

// OpenAPI 生成类型的简称(单一契约源 openapi/openapi.yaml → swift-openapi-generator)。
// 业务层用这些别名替代手写 DTO,字段与线上 JSON 一一对应,跨端共享同一契约。
public typealias APIUser = Components.Schemas.User
public typealias APILoginData = Components.Schemas.LoginData
public typealias APIMessage = Components.Schemas.Message
public typealias APIMessagePreview = Components.Schemas.MessagePreview
public typealias APIFileInfo = Components.Schemas.FileInfo
public typealias APIConversation = Components.Schemas.Conversation
public typealias APIUserConversation = Components.Schemas.UserConversation
public typealias APIFriendList = Components.Schemas.FriendList
public typealias APIFriendInfo = Components.Schemas.FriendInfo
public typealias APISearchUserResult = Components.Schemas.SearchUserResult
public typealias APIFriendRequest = Components.Schemas.FriendRequest
public typealias APIUploadResult = Components.Schemas.UploadResult
