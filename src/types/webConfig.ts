export interface Theme {
    name: string
    default?: boolean;
    id: string
    color: string
}

export interface MenuLink {
    name: string
    icon?: string
    url: string
}

export interface WebConfig {
    includeCorsCredentials?: boolean
    multiserver?: boolean
    enableWebGPUVideoPlayer?: boolean
    enableWebGPUCustomDecode?: boolean
    enableWebGPUHDRToneMapping?: boolean
    enableWebGPUValidationHarness?: boolean
    themes?: Theme[]
    menuLinks?: MenuLink[]
    servers?: string[]
    plugins?: string[]
}
