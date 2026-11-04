/** A trimmed `/v1/models?client_version=…` answer in the shape CPA returns. */
export const CPA_CATALOG = {
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
      context_window: 500000,
      max_context_window: 872000,
      input_modalities: ['text', 'image'],
      visibility: 'list',
    },
    {
      slug: 'gpt-6-luna',
      display_name: 'GPT-6-Luna',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' },
      ],
      service_tiers: [{ id: 'priority', name: 'Fast' }],
      context_window: 272000,
      max_context_window: 872000,
      input_modalities: ['text', 'image'],
      visibility: 'list',
    },
    {
      slug: 'claude-sonnet-4-5',
      display_name: 'Claude Sonnet 4.5',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
      service_tiers: [],
      context_window: 200000,
      max_tokens: 64000,
      input_modalities: ['text', 'image'],
      visibility: 'list',
    },
    {
      slug: 'gpt-image-2',
      display_name: 'GPT Image 2',
      supported_reasoning_levels: [],
      service_tiers: [],
      visibility: 'hide',
    },
    { slug: 'gpt-5.5', display_name: 'duplicate, dropped' },
    { display_name: 'no id, dropped' },
  ],
}
