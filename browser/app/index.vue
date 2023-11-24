<script setup>
	import { ref, onMounted, watch } from "vue";


	const workIdList = ref([]);
	const workId = ref("");


	onMounted(async () => {
		const response = await fetch("/workid-list");
		workIdList.value = await response.json();
		//console.log("workIds:", workIdList.value);
	});


	watch(workId, (value) => {
		console.log("workId:", value);
	});
</script>

<template>
	<div>
		<datalist id="workid-list">
			<option v-for="id of workIdList" :key="id" :value="id" />
		</datalist>
		<input type="text" v-model.lazy="workId" list="workid-list" />
	</div>
</template>

<style scoped>
</style>
