<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FileWarning, Lock, Unlock } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  encrypted: [];
  plain: [];
}>();

const { t } = useI18n();
const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ t("configExport.modeTitle") }}</DialogTitle>
      </DialogHeader>

      <div class="grid gap-4 py-4">
        <p class="text-sm text-muted-foreground">{{ t("configExport.modeHint") }}</p>

        <div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div class="flex items-start gap-2">
            <FileWarning class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{{ t("configExport.plainExportWarning") }}</span>
          </div>
        </div>
      </div>

      <DialogFooter class="gap-2 sm:justify-between">
        <Button variant="outline" @click="emit('encrypted')">
          <Lock class="mr-2 h-4 w-4" />
          {{ t("configExport.exportEncrypted") }}
        </Button>
        <Button variant="destructive" @click="emit('plain')">
          <Unlock class="mr-2 h-4 w-4" />
          {{ t("configExport.exportPlain") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
