import { ModelConfig, ProviderConfig, inputStyle, providerLabels } from "./types";

export function ModelSelect({ value, onChange, allowEmpty, emptyLabel, modelConfigs, providerConfigs }: {
    value: string;
    onChange: (v: string) => void;
    allowEmpty?: boolean;
    emptyLabel?: string;
    modelConfigs: ModelConfig[];
    providerConfigs: ProviderConfig[];
}) {
    const normalizedValue = String(value || "").trim();
    const hiddenSelectionValue = "__hidden_selected__";

    // 只显示可见的模型，且服务商也必须可见
    const visibleProviders = new Set(providerConfigs.filter(p => p.visible === 1).map(p => p.provider));
    const visibleModels = modelConfigs.filter(m => m.visible === 1 && visibleProviders.has(m.provider));
    const hasVisibleSelected = normalizedValue
        ? visibleModels.some((m) => m.model_id === normalizedValue)
        : false;
    const shouldForceReselect = !!normalizedValue && !hasVisibleSelected;
    const selectValue = shouldForceReselect ? hiddenSelectionValue : normalizedValue;

    // 按服务商分组
    const groupedModels = visibleModels.reduce((acc, model) => {
        if (!acc[model.provider]) {
            acc[model.provider] = [];
        }
        acc[model.provider].push(model);
        return acc;
    }, {} as Record<string, ModelConfig[]>);

    return (
        <select
            style={inputStyle}
            value={selectValue}
            onChange={(e) => {
                if (e.target.value === hiddenSelectionValue) return;
                onChange(e.target.value);
            }}
        >
            {shouldForceReselect && (
                <option value={hiddenSelectionValue} disabled>
                    当前模型不可见（服务商已隐藏），请重新选择
                </option>
            )}
            {allowEmpty && <option value="">{emptyLabel || "跟随项目默认"}</option>}
            {Object.entries(groupedModels).map(([provider, models]) => (
                <optgroup key={provider} label={providerLabels[provider] || provider}>
                    {models.map((m) => (
                        <option key={`${m.provider}:${m.id}`} value={m.model_id}>{m.model_label}</option>
                    ))}
                </optgroup>
            ))}
        </select>
    );
}
